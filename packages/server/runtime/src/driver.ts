import { PassThrough } from "node:stream";

export interface RunOptions {
  runId: string;
  prompt: string;
  chatContext?: string;
  agentFileId?: string;
  onLog: (event: LogEvent) => void;
}

export interface LogEvent {
  runId: string;
  seq: number;
  kind: "stdout" | "stderr" | "event";
  payload: string;
}

export interface ExecResult {
  exitCode: number;
}

export interface SandboxDriver {
  execRun(agentId: string, opts: RunOptions): Promise<ExecResult>;
  cancelRun(runId: string): Promise<void>;
}

/**
 * Creates the appropriate sandbox driver based on environment.
 * DESK_SANDBOX_DRIVER=fake → fake driver (for tests)
 * Otherwise → real Docker driver
 */
export function createDriver(): SandboxDriver {
  if (process.env.DESK_SANDBOX_DRIVER === "fake") {
    return createFakeDriver();
  }
  return createRealDriver();
}

function createFakeDriver(): SandboxDriver {
  const cancelled = new Set<string>();

  return {
    async execRun(_agentId, opts) {
      const { runId, onLog } = opts;

      const lines = [
        "Starting fake sandbox run...",
        `Processing prompt: ${opts.prompt.slice(0, 50)}...`,
        "Fake response generated.",
        "Run complete.",
      ];

      let seq = 0;
      for (const line of lines) {
        if (cancelled.has(runId)) {
          return { exitCode: 130 }; // SIGINT
        }
        onLog({ runId, seq: seq++, kind: "stdout", payload: line });
        await new Promise((r) => setTimeout(r, 10));
      }

      return { exitCode: 0 };
    },

    async cancelRun(runId) {
      cancelled.add(runId);
    },
  };
}

/** Tracks active docker exec instances by runId for cancellation. */
const activeExecs = new Map<string, { containerId: string; execId: string }>();

function createRealDriver(): SandboxDriver {
  return {
    async execRun(_agentId, opts) {
      const { createOrReuse, dockerSocketPath } = await import("./docker.js");
      const Docker = (await import("dockerode")).default;
      const docker = new Docker({ socketPath: dockerSocketPath() });

      // Use createOrReuse which includes containerBinds (project mounts)
      const handle = await createOrReuse(_agentId);
      const container = docker.getContainer(handle.containerId);

      // Build the full prompt including chat context if provided.
      // The system prompt is handled by the OpenCode agent file, not inlined here.
      const fullPrompt = [opts.chatContext, opts.prompt]
        .filter(Boolean)
        .join("\n\n");

      // opencode run reads the prompt as a positional arg; pass it via env to
      // avoid arg-length limits, then `exec opencode run "$DESK_PROMPT" ...`.
      const agentFlag = opts.agentFileId ? ` --agent ${opts.agentFileId}` : "";
      const cmd = [
        "sh", "-c",
        `exec opencode run "$DESK_PROMPT"${agentFlag} --dangerously-skip-permissions --format json`,
      ];

      const exec = await container.exec({
        Cmd: cmd,
        Env: [
          `DESK_TOOL_TOKEN=${opts.runId}`,
          `DESK_TOOL_SOCKET=/run/desk/tools.sock`,
          `DESK_PROMPT=${fullPrompt}`,
        ],
        AttachStdout: true,
        AttachStderr: true,
      });

      const stream = await exec.start({ hijack: true, stdin: false });

      // Track this exec for cancellation
      const inspectInitial = await exec.inspect();
      const containerInfo = await container.inspect();
      activeExecs.set(opts.runId, {
        containerId: containerInfo.Id,
        execId: inspectInitial.ID,
      });

      let seq = 0;

      return new Promise<ExecResult>((resolve) => {
        // Docker's exec stream (no TTY) is multiplexed: every frame is prefixed
        // with an 8-byte header [stream_id, 0, 0, 0, len_be32]. Demux so we
        // see clean stdout/stderr text.
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        // dockerode's modem demuxes the frames onto the two sinks and signals
        // end on each when the source ends. Use the modem that the driver
        // already imported above.
        docker.modem.demuxStream(stream, stdout, stderr);

        // Accumulate lines — we emit one onLog per data chunk, but only after
        // a full frame's payload has been reassembled by the demuxer.
        const emit = (kind: "stdout" | "stderr") => (chunk: Buffer) => {
          const text = chunk.toString("utf8").replace(/\r?\n$/, "");
          if (text) {
            opts.onLog({ runId: opts.runId, seq: seq++, kind, payload: text });
          }
        };
        stdout.on("data", emit("stdout"));
        stderr.on("data", emit("stderr"));

        // Wait for both demuxed streams to finish before resolving, so no
        // frames are lost between stream.end and the promise resolution.
        let stdoutDone = false;
        let stderrDone = false;
        let rawDone = false;

        const maybeResolve = async () => {
          if (!(stdoutDone && stderrDone && rawDone)) return;
          activeExecs.delete(opts.runId);
          const inspectData = await exec.inspect();
          resolve({ exitCode: inspectData.ExitCode ?? 1 });
        };

        stdout.on("end", () => { stdoutDone = true; void maybeResolve(); });
        stderr.on("end", () => { stderrDone = true; void maybeResolve(); });

        stream.on("end", () => {
          rawDone = true;
          // End the demux sinks explicitly so their "end" fires reliably.
          stdout.end();
          stderr.end();
        });

        stream.on("error", () => {
          activeExecs.delete(opts.runId);
          resolve({ exitCode: 1 });
        });
      });
    },

    async cancelRun(runId) {
      const tracked = activeExecs.get(runId);
      if (!tracked) return;

      const { dockerSocketPath } = await import("./docker.js");
      const Docker = (await import("dockerode")).default;
      const docker = new Docker({ socketPath: dockerSocketPath() });
      const container = docker.getContainer(tracked.containerId);

      // Find the exec's PID inside the container and kill it
      try {
        const topResult = await container.top();
        // Look for the opencode process among running processes
        const procs = topResult.Processes ?? [];
        for (const proc of procs) {
          const cmdStr = proc[proc.length - 1] ?? "";
          if (cmdStr.includes("opencode")) {
            const pid = proc[1]; // PID column
            // Send SIGTERM first
            await container.exec({
              Cmd: ["kill", "-TERM", pid],
            }).then((e: { start: (o: object) => Promise<unknown> }) => e.start({ Detach: true }));
            break;
          }
        }

        // Grace period then SIGKILL if still tracked
        await new Promise((r) => setTimeout(r, 3000));
        if (activeExecs.has(runId)) {
          const topRetry = await container.top();
          const retryProcs = topRetry.Processes ?? [];
          for (const proc of retryProcs) {
            const cmdStr = proc[proc.length - 1] ?? "";
            if (cmdStr.includes("opencode")) {
              const pid = proc[1];
              await container.exec({
                Cmd: ["kill", "-KILL", pid],
              }).then((e: { start: (o: object) => Promise<unknown> }) => e.start({ Detach: true }));
              break;
            }
          }
        }
      } catch {
        // Container may have stopped or exec already finished
      } finally {
        activeExecs.delete(runId);
      }
    },
  };
}
