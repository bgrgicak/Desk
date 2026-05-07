import { SANDBOX_HOME } from "./mounts.js";

export interface RunOptions {
  runId: string;
  prompt: string;
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
   * Opencode model id to pass via `--model`, e.g. "opencode/big-pickle".
   * When omitted, opencode picks its default.
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
  if (process.env.DESK_SANDBOX_DRIVER === "fake") {
    return createFakeDriver();
  }
  return createRealDriver();
}

function createFakeDriver(): SandboxDriver {
  const cancelled = new Set<string>();

  return {
    async execRun(_workspaceId, opts) {
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
          return { exitCode: 130 };
        }
        await onLog({ runId, seq: seq++, kind: "stdout", payload: line });
        await new Promise((r) => setTimeout(r, 10));
      }

      return { exitCode: 0 };
    },

    async cancelRun(runId) {
      cancelled.add(runId);
    },
  };
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

/** Tracks active execs by runId so cancelRun can find the in-container PID to kill. */
const activeExecs = new Map<string, { containerId: string }>();

function createRealDriver(): SandboxDriver {
  return {
    async execRun(workspaceId, opts) {
      const { createOrReuse, providerKeyEnv, sandboxUser } = await import("./docker.js");
      const { detectEngine } = await import("./engine.js");
      const engine = await detectEngine();

      const handle = await createOrReuse(workspaceId, opts.workspaceSlug, undefined, opts.providerKeys);

      // The system prompt — including the per-chat artifact paths and the
      // user's goal fragment — lives entirely in the OpenCode agent file
      // written by writeAgentFile, so the per-turn prompt is just the
      // user's text.
      const fullPrompt = opts.prompt;

      const cmd = buildOpencodeCommand({
        agentFileId: opts.agentFileId,
        attachments: opts.attachments,
        model: opts.model,
      });

      const handle$ = await engine.exec({
        containerId: handle.containerId,
        cmd,
        user: await sandboxUser(engine),
        env: [
          `DESK_PROMPT=${fullPrompt}`,
          ...(opts.sandboxToken ? [`DESK_SANDBOX_TOKEN=${opts.sandboxToken}`] : []),
          ...(opts.apiUrl ? [`DESK_API_URL=${opts.apiUrl}`] : []),
          // Inject provider keys per-exec so a key added after the container
          // was created takes effect immediately without recreation.
          ...providerKeyEnv(opts.providerKeys),
        ],
      });

      activeExecs.set(opts.runId, { containerId: handle.containerId });

      let seq = 0;
      // The engine hands us already-demuxed stdout/stderr (the CLI
      // separates them when neither -t nor -T is in play). We track every
      // onLog return so the final resolve waits for async event appends to
      // commit — fast-exiting opencode runs (sub-second) would otherwise
      // race the stream 'end' against the last DB INSERTs and leave the
      // assistant-message write pointing at zero events.
      const pendingLogs: Promise<unknown>[] = [];
      const emit = (kind: "stdout" | "stderr") => (chunk: Buffer) => {
        const text = chunk.toString("utf8").replace(/\r?\n$/, "");
        if (!text) return;
        const ret = opts.onLog({ runId: opts.runId, seq: seq++, kind, payload: text });
        if (ret && typeof (ret as Promise<void>).then === "function") {
          pendingLogs.push(
            (ret as Promise<void>).catch(() => {
              // Per-log failures are intentionally swallowed — one bad
              // append shouldn't fail the whole run.
            }),
          );
        }
      };
      handle$.stdout.on("data", emit("stdout"));
      handle$.stderr.on("data", emit("stderr"));

      const exitCode = await handle$.wait();
      await Promise.all(pendingLogs);
      activeExecs.delete(opts.runId);
      return { exitCode };
    },

    async cancelRun(runId) {
      const tracked = activeExecs.get(runId);
      if (!tracked) return;

      const { detectEngine } = await import("./engine.js");
      const engine = await detectEngine();

      try {
        const procs = await engine.top(tracked.containerId);
        const target = procs.find((p) => p.cmd.includes("opencode"));
        if (target) {
          // SIGTERM first, then SIGKILL after a grace period if still
          // alive. Both signals are dispatched via a short exec so the
          // signal lands in the container's PID namespace, not the host.
          const sendSignal = async (sig: "TERM" | "KILL") => {
            const h = await engine.exec({
              containerId: tracked.containerId,
              cmd: ["kill", `-${sig}`, target.pid],
            });
            await h.wait();
          };
          await sendSignal("TERM");
          await new Promise((r) => setTimeout(r, 3000));
          if (activeExecs.has(runId)) {
            const stillRunning = (await engine.top(tracked.containerId)).find(
              (p) => p.pid === target.pid,
            );
            if (stillRunning) await sendSignal("KILL");
          }
        }
      } catch {
        // Container may have stopped or exec already finished.
      } finally {
        activeExecs.delete(runId);
      }
    },
  };
}
