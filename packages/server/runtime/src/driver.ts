import { PassThrough } from "node:stream";
import { SANDBOX_HOME } from "./mounts.js";

export interface RunOptions {
  runId: string;
  prompt: string;
  chatContext?: string;
  agentFileId?: string;
  /**
   * Workspace-relative paths the user attached to this message. The driver
   * translates each to its sandbox-absolute form (`${SANDBOX_HOME}/<rel>`)
   * and passes it to opencode via `--file`, so the model sees the actual
   * attached files instead of having to fetch them through tools.
   */
  attachments?: string[];
  /** On-disk slug for the workspace this run belongs to — feeds the mount plan + container name. */
  workspaceSlug: string;
  /**
   * Called once per stdout/stderr/event log line. May be sync or async — the
   * driver tracks any returned promise and awaits all of them before
   * resolving `execRun`, so callers that persist events asynchronously
   * (e.g. into a DB) are safe from the race where `execRun` resolves before
   * the last append commits.
   */
  onLog: (event: LogEvent) => void | Promise<void>;
  /**
   * Opencode model id to pass via `--model`, e.g. "opencode/big-pickle" or
   * "anthropic/claude-sonnet-4-6". When omitted, opencode picks its default.
   */
  model?: string;
  /**
   * Provider API keys injected as env vars on every `docker exec` call, so
   * a key added after the container was first created takes effect immediately
   * without requiring a container restart or recreation.
   */
  providerKeys?: Record<string, string>;
  /**
   * Per-run sandbox session token. The driver passes it into the container
   * as `DESK_SANDBOX_TOKEN`; the in-sandbox `desk` CLI forwards it to the
   * REST API as `X-Desk-Sandbox-Token`. Omit in fake-driver tests that
   * don't exercise the CLI.
   */
  sandboxToken?: string;
  /**
   * URL the in-sandbox `desk` CLI POSTs to. Resolves to the host-side
   * desk-server (typically `http://host.docker.internal:${PORT}`).
   */
  apiUrl?: string;
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
  /** Kicks off an opencode run in the given workspace's sandbox. */
  execRun(workspaceId: string, opts: RunOptions): Promise<ExecResult>;
  cancelRun(runId: string): Promise<void>;
}

export function createDriver(): SandboxDriver {
  return createRealDriver();
}

/**
 * Maps a workspace-relative attachment path to the matching sandbox path.
 * The whole workspace is bind-mounted at SANDBOX_HOME, so the rule is just
 * to prepend the home and strip any leading slash so a stray absolute-style
 * input doesn't double up.
 */
export function toSandboxPath(rel: string): string {
  return `${SANDBOX_HOME}/${rel.replace(/^\/+/, "")}`;
}

/** POSIX single-quote escape: wrap in `'...'`, embedded `'` becomes `'\''`. */
export function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds the `sh -c` invocation that runs opencode inside the sandbox.
 * The prompt itself is passed via `$DESK_PROMPT` (set in the exec env) to
 * dodge arg-length limits; this function only wires the flags. Exported so
 * the command synthesis is unit-testable without Docker.
 */
export function buildOpencodeCommand(opts: {
  agentFileId?: string;
  attachments?: string[];
  model?: string;
}): string[] {
  const agentFlag = opts.agentFileId ? ` --agent ${opts.agentFileId}` : "";
  const fileFlags = (opts.attachments ?? [])
    .map((p) => ` --file ${shSingleQuote(toSandboxPath(p))}`)
    .join("");
  const modelFlag = opts.model ? ` --model ${shSingleQuote(opts.model)}` : "";
  return [
    "sh", "-c",
    `exec opencode run "$DESK_PROMPT"${agentFlag}${fileFlags}${modelFlag} --dangerously-skip-permissions --format json`,
  ];
}

/** Tracks active docker exec instances by runId for cancellation. */
const activeExecs = new Map<string, { containerId: string; execId: string }>();

function createRealDriver(): SandboxDriver {
  return {
    async execRun(workspaceId, opts) {
      const { createOrReuse, dockerSocketPath, providerKeyEnv } = await import("./docker.js");
      const Docker = (await import("dockerode")).default;
      const docker = new Docker({ socketPath: dockerSocketPath() });

      // Use createOrReuse which includes containerBinds (project mounts)
      const handle = await createOrReuse(workspaceId, opts.workspaceSlug, undefined, opts.providerKeys);
      const container = docker.getContainer(handle.containerId);

      // Build the full prompt including chat context if provided.
      // The system prompt is handled by the OpenCode agent file, not inlined here.
      const fullPrompt = [opts.chatContext, opts.prompt]
        .filter(Boolean)
        .join("\n\n");

      const cmd = buildOpencodeCommand({
        agentFileId: opts.agentFileId,
        attachments: opts.attachments,
        model: opts.model,
      });

      const exec = await container.exec({
        Cmd: cmd,
        Env: [
          `DESK_PROMPT=${fullPrompt}`,
          ...(opts.sandboxToken ? [`DESK_SANDBOX_TOKEN=${opts.sandboxToken}`] : []),
          ...(opts.apiUrl ? [`DESK_API_URL=${opts.apiUrl}`] : []),
          // Inject provider keys per-exec so a key added after the container
          // was created takes effect immediately without recreation.
          ...providerKeyEnv(opts.providerKeys),
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
        // a full frame's payload has been reassembled by the demuxer. Track
        // every onLog return so maybeResolve can await them: callers persist
        // events asynchronously and a fast-exiting opencode (sub-second runs)
        // would otherwise race — stream 'end' resolves execRun before the last
        // INSERTs commit, the scheduler then reads back zero events and skips
        // the assistant-message write. Surfaced in prod: ~5 successful runs
        // with exit 0 and zero run_events for very short prompts.
        const pendingLogs: Promise<unknown>[] = [];
        const emit = (kind: "stdout" | "stderr") => (chunk: Buffer) => {
          const text = chunk.toString("utf8").replace(/\r?\n$/, "");
          if (text) {
            const ret = opts.onLog({ runId: opts.runId, seq: seq++, kind, payload: text });
            if (ret && typeof (ret as Promise<void>).then === "function") {
              pendingLogs.push(
                (ret as Promise<void>).catch(() => {
                  // Per-log failures are intentionally swallowed — one bad
                  // append shouldn't fail the whole run.
                }),
              );
            }
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
          // Wait for all async onLog calls to commit before resolving.
          await Promise.all(pendingLogs);
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
