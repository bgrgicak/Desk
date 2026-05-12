import { SANDBOX_HOME, SKILLS_SANDBOX_DIR } from "./mounts.js";
import type { Engine, ExecHandle } from "./engine.js";
import { managedConnectionDefinitions } from "@agent-desk/shared";

export interface RunOptions {
  runId: string;
  prompt: string;
  /**
   * Sandbox-absolute path to a file containing the prompt text. When set,
   * the driver reads the prompt from this file via `cat` instead of passing
   * it in the `DESK_PROMPT` environment variable, dodging the ARG_MAX limit
   * that `execve` applies to the combined size of arguments + environment.
   * The caller is responsible for writing and cleaning up this file.
   */
  promptFile?: string;
  /** Sandbox-absolute path to a file containing the full system prompt for runtimes that accept it. */
  systemPromptFile?: string;
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
  /** Chat this run belongs to. Exported so in-sandbox CLIs can reject cross-chat writes. */
  chatId?: string;
  /** DESK_HOME root. When omitted, runtime storage resolution is used. */
  home?: string;
  /**
   * Called once per stdout/stderr/event log line. May be sync or async — the
   * driver tracks any returned promise and awaits all of them before
   * resolving `execRun`, so callers that persist events asynchronously
   * (e.g. into a DB) are safe from the race where `execRun` resolves before
   * the last append commits.
   */
  onLog: (event: LogEvent) => void | Promise<void>;
  /**
   * Agent runtime model id to pass via `--model`, e.g. "opencode/big-pickle".
   * When omitted, the selected runtime picks its default.
   */
  model?: string;
  /**
   * Provider API keys injected as env vars on every `docker exec` call, so
   * a key added after the container was first created takes effect immediately
   * without requiring a container restart or recreation.
   */
  providerKeys?: Record<string, string>;
  /**
   * Non-key env vars (e.g. `OPENCODE_AUTH_CONTENT`) injected on every exec.
   * Re-read per run so a refreshed Codex token on the host propagates without
   * having to recreate the sandbox.
   */
  extraEnv?: Record<string, string>;
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
  /** Kicks off an agent-runtime run in the given workspace's sandbox. */
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

      const stepDelayMs = parseInt(process.env.DESK_FAKE_DRIVER_STEP_DELAY_MS ?? "10", 10);
      let seq = 0;
      for (const line of lines) {
        if (cancelled.has(runId)) {
          return { exitCode: 130 };
        }
        await onLog({ runId, seq: seq++, kind: "stdout", payload: line });
        await new Promise((r) => setTimeout(r, stepDelayMs));
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
 *
 * When `promptFile` is set the prompt is read from that sandbox path via
 * `$(cat "$DESK_PROMPT_FILE")`, which avoids putting large text in the
 * `execve` argument/environment block and hitting the ARG_MAX limit.
 * Otherwise the prompt is read from `$DESK_PROMPT`.
 *
 * Exported so the command synthesis is unit-testable without Docker.
 */
export function buildOpencodeCommand(opts: {
  runId?: string;
  agentFileId?: string;
  attachments?: string[];
  model?: string;
  promptFile?: string;
}): string[] {
  const agentFlag = opts.agentFileId ? ` --agent ${opts.agentFileId}` : "";
  const fileFlags = (opts.attachments ?? [])
    .map((p) => ` --file ${shSingleQuote(toSandboxPath(p))}`)
    .join("");
  const modelFlag = opts.model ? ` --model ${shSingleQuote(opts.model)}` : "";
  const promptExpr = opts.promptFile ? `"$(cat "$DESK_PROMPT_FILE")"` : `"$DESK_PROMPT"`;
  const pidFile = runPidFile(opts.runId ?? "unknown");
  const sandboxAuthSetup = buildSandboxAuthSetup(opts.runId ?? "unknown");
  const opencode = `opencode run ${promptExpr}${agentFlag}${fileFlags}${modelFlag} --dangerously-skip-permissions --format json`;
  const script = [
    "mkdir -p /tmp/desk-runs",
    `pidfile=${shSingleQuote(pidFile)}`,
    sandboxAuthSetup,
    "if command -v setsid >/dev/null 2>&1; then " +
      // setsid makes the OpenCode exec a process-group leader. --wait is
      // important: util-linux setsid may fork when its caller is already a
      // process-group leader. Without --wait the docker exec wrapper can exit
      // immediately, causing our finally cleanup to kill the just-started run.
      // We write the leader PID before exec so cancel/finally cleanup can
      // signal the whole tree, including MCP/build grandchildren that would
      // otherwise survive.
      `setsid --wait sh -c 'echo $$ > "$1"; shift; exec "$@"' sh "$pidfile" ${opencode}; status=$?; exit "$status"`,
    "else " +
      // Older/minimal sandbox images may not include util-linux/setsid. Do not
      // fail the run at startup in that case; record the opencode PID and run
      // normally. Cancellation can still fall back to killing the docker exec
      // wrapper, and the next rebuilt image can restore process-group cleanup.
      `echo 'Desk runtime warning: setsid unavailable; process-tree cleanup degraded' >&2; sh -c 'echo $$ > "$1"; shift; exec "$@"' sh "$pidfile" ${opencode}; status=$?; exit "$status"`,
    "fi",
  ].join("; ");
  return [
    "sh", "-c",
    script,
  ];
}

/**
 * Builds the `sh -c` invocation that runs Pi inside the sandbox.
 *
 * Pi uses `@file` positional arguments for attachments. Desk writes the full
 * runtime system prompt to a workspace-local `.pi/SYSTEM-<run>.md` file and
 * appends it explicitly, while `--no-context-files` suppresses unrelated
 * AGENTS.md/CLAUDE.md files.
 */
export function buildPiCommand(opts: {
  runId?: string;
  attachments?: string[];
  model?: string;
  promptFile?: string;
  systemPromptFile?: string;
}): string[] {
  const fileArgs = (opts.attachments ?? [])
    .map((p) => ` ${shSingleQuote(`@${toSandboxPath(p)}`)}`)
    .join("");
  const modelFlag = opts.model ? ` --model ${shSingleQuote(opts.model)}` : "";
  const promptPipe = opts.promptFile ? `cat "$DESK_PROMPT_FILE" | ` : "";
  const promptArg = opts.promptFile ? "" : ` "$DESK_PROMPT"`;
  // Pi resolves --append-system-prompt as either literal text or a readable
  // file path. Pass the file path directly instead of command-substituting the
  // contents into argv, otherwise a large Desk prompt can still hit ARG_MAX.
  const systemPromptFlag = opts.systemPromptFile ? ` --append-system-prompt "$DESK_PI_SYSTEM_PROMPT_FILE"` : "";
  const pidFile = runPidFile(opts.runId ?? "unknown");
  const piAgentDir = piAgentDirForRun(opts.runId ?? "unknown");
  const piAuthSetup = buildPiAuthSetup(piAgentDir);
  // Keep Pi's built-in tool set aligned with OpenCode while also enabling the
  // pi-mcp-adapter proxy tool. Pi applies `--tools` as a global allowlist across
  // built-in, extension, and custom tools; omitting `mcp` would load the adapter
  // but make browser/MCP tools unreachable.
  const toolsFlag = " --tools read,write,edit,bash,grep,find,ls,mcp";
  const skillFlag = ` --skill ${shSingleQuote(SKILLS_SANDBOX_DIR)}`;
  const extensionFlag = " --extension '/opt/pi-extensions/mcp-adapter/node_modules/pi-mcp-adapter/index.ts'";
  const pi = `cd "$HOME" && ${promptPipe}PI_CODING_AGENT_DIR=${shSingleQuote(piAgentDir)} PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 PI_OFFLINE=1 pi --offline --mode json -p --no-session --no-context-files${systemPromptFlag}${toolsFlag}${skillFlag}${extensionFlag}${modelFlag}${fileArgs}${promptArg}`;
  const piScriptArg = shSingleQuote(pi);
  const script = [
    "mkdir -p /tmp/desk-runs",
    `pidfile=${shSingleQuote(pidFile)}`,
    piAuthSetup,
    "if command -v setsid >/dev/null 2>&1; then " +
      `exec setsid --wait sh -c 'echo $$ > "$1"; shift; exec sh -c "$1"' sh "$pidfile" ${piScriptArg}`,
    "else " +
      `echo 'Desk runtime warning: setsid unavailable; process-tree cleanup degraded' >&2; exec sh -c 'echo $$ > "$1"; shift; exec sh -c "$1"' sh "$pidfile" ${piScriptArg}`,
    "fi",
  ].join("; ");
  return ["sh", "-c", script];
}

export function buildPiAuthSetup(agentDir: string): string {
  const dir = shSingleQuote(agentDir);
  return `pi_agent_dir=${dir}; mkdir -p "$pi_agent_dir"; ` +
    "if [ -n \"${PI_AUTH_CONTENT:-}\" ]; then " +
    "printf '%s' \"$PI_AUTH_CONTENT\" > \"$pi_agent_dir/auth.json\" && chmod 600 \"$pi_agent_dir/auth.json\"; " +
    "elif [ -n \"${OPENCODE_AUTH_CONTENT:-}\" ]; then " +
    "printf '%s' \"$OPENCODE_AUTH_CONTENT\" | jq -c '{\"openai-codex\":(.openai // .[\"openai-codex\"])} | with_entries(select(.value != null))' > \"$pi_agent_dir/auth.json\" && chmod 600 \"$pi_agent_dir/auth.json\"; " +
    "fi";
}

export function piAgentDirForRun(runId: string): string {
  return `/tmp/desk-runs/pi-agent-${safeRunId(runId)}`;
}

function selectedAgentRuntime(): "opencode" | "pi" {
  return process.env.DESK_AGENT_RUNTIME === "pi" ? "pi" : "opencode";
}

export function runtimeModelForPi(model: string | undefined, extraEnv: Record<string, string> | undefined): string | undefined {
  if (process.env.DESK_PI_MODEL) return process.env.DESK_PI_MODEL;
  const hasCodexAuth = Boolean(extraEnv?.PI_AUTH_CONTENT || extraEnv?.OPENCODE_AUTH_CONTENT);
  if (!model || model.startsWith("opencode/")) return hasCodexAuth ? "openai-codex/gpt-5.5" : undefined;
  // OpenCode consumes Desk's Codex bridge as openai/*; Pi exposes the same
  // ChatGPT subscription as openai-codex/*. Map existing agent selections when
  // Codex auth is present so switching DESK_AGENT_RUNTIME=pi keeps working.
  if (hasCodexAuth && model.startsWith("openai/")) {
    return `openai-codex/${model.slice("openai/".length)}`;
  }
  return model;
}

/** Tracks active execs by runId so cancelRun can find the in-container PID to kill. */
const activeExecs = new Map<string, { containerId: string; pidFile: string; execHandle: ExecHandle }>();

export function createRuntimeLogLineEmitter(
  emitLine: (kind: "stdout" | "stderr", line: string) => void,
): {
  ingest(kind: "stdout" | "stderr", chunk: Buffer | string): void;
  flush(): void;
} {
  const buffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };

  const emitBufferedLines = (kind: "stdout" | "stderr") => {
    let buffer = buffers[kind];
    let newlineIdx = buffer.indexOf("\n");
    while (newlineIdx >= 0) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
      emitLine(kind, line);
      buffer = buffer.slice(newlineIdx + 1);
      newlineIdx = buffer.indexOf("\n");
    }
    buffers[kind] = buffer;
  };

  return {
    ingest(kind, chunk) {
      buffers[kind] += chunk.toString();
      emitBufferedLines(kind);
    },
    flush() {
      for (const kind of ["stdout", "stderr"] as const) {
        const line = buffers[kind].replace(/\r$/, "");
        buffers[kind] = "";
        if (line) emitLine(kind, line);
      }
    },
  };
}

function runPidFile(runId: string): string {
  // Keep the filename shell-safe even if a test injects an odd id. Production
  // run ids are already generated identifiers, but cleanup commands are too
  // sensitive to trust that implicitly.
  return `/tmp/desk-runs/${safeRunId(runId)}.pid`;
}

function buildSandboxAuthSetup(runId: string): string {
  return managedConnectionDefinitions()
    .map((definition) => {
      const setup = definition.sandboxSetup ? SANDBOX_AUTH_SETUP_BUILDERS[definition.sandboxSetup] : undefined;
      return setup ? setup(runId) : "";
    })
    .filter(Boolean)
    .join("; ");
}

const SANDBOX_AUTH_SETUP_BUILDERS = {
  "github-askpass": buildGitHubAskpassSetup,
} satisfies Record<string, (runId: string) => string>;

function buildGitHubAskpassSetup(runId: string): string {
  const askpassFile = `/tmp/desk-github-askpass-${safeRunId(runId)}`;
  return "if [ -n \"${GITHUB_TOKEN:-${GH_TOKEN:-}}\" ]; then " +
    `askpass=${shSingleQuote(askpassFile)}; ` +
    "umask 077; " +
    "printf '%s\\n' '#!/bin/sh' 'case \"$1\" in' '  *Username*) printf '\''%s'\'' '\''x-access-token'\'' ;;' '  *) printf '\''%s'\'' \"${GITHUB_TOKEN:-${GH_TOKEN:-}}\" ;;' 'esac' > \"$askpass\"; " +
    "chmod 700 \"$askpass\"; " +
    "trap 'rm -f \"$askpass\"' EXIT HUP INT TERM; " +
    "export GH_TOKEN=\"${GH_TOKEN:-$GITHUB_TOKEN}\" GITHUB_TOKEN=\"${GITHUB_TOKEN:-$GH_TOKEN}\" GIT_ASKPASS=\"$askpass\" GIT_TERMINAL_PROMPT=0; " +
    "fi";
}

function safeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * Force-kill a previously-started run's process tree, given its runId. Used
 * at desk-server startup to reap opencode processes left alive in a sandbox
 * by a previous desk-server (e.g. tsx-watch reload, crash) so the re-fire
 * doesn't spawn a second opencode that fights the first for the workspace's
 * `~/.local/share/opencode/opencode.db`. Returns true if a process group
 * was signalled. Idempotent: if the pidfile is absent, the leader is dead,
 * or the container exec fails, it resolves to false without throwing.
 */
export async function killRunProcessTreeByRunId(
  engine: Engine,
  containerId: string,
  runId: string,
): Promise<boolean> {
  return cleanupRunProcessTree(engine, containerId, runPidFile(runId), {
    waitForPidFileMs: 0,
    removePidFileWhenMissing: true,
  });
}

export async function _cleanupRunProcessTreeForTest(
  engine: Engine,
  containerId: string,
  pidFile: string,
  opts: Parameters<typeof cleanupRunProcessTree>[3] = {},
): Promise<boolean> {
  return cleanupRunProcessTree(engine, containerId, pidFile, opts);
}

async function cleanupRunProcessTree(
  engine: Engine,
  containerId: string,
  pidFile: string,
  opts: {
    waitForPidFileMs?: number;
    removePidFileWhenMissing?: boolean;
  } = {},
): Promise<boolean> {
  let sawPidFile = false;
  const waitForPidFile = async () => {
    const deadline = Date.now() + (opts.waitForPidFileMs ?? 0);
    while (true) {
      const h = await engine.exec({
        containerId,
        cmd: ["sh", "-c", `[ -s ${shSingleQuote(pidFile)} ]`],
      });
      if ((await h.wait()) === 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const execCleanup = async (signal: "TERM" | "KILL") => {
    const script = [
      `pidfile=${shSingleQuote(pidFile)}`,
      'pid="$(cat "$pidfile" 2>/dev/null || true)"',
      'case "$pid" in ""|*[!0-9]*) exit 0;; esac',
      // Signal only the run's process group. Avoid a direct-PID fallback here:
      // after the OpenCode leader exits, PID reuse inside a warm sandbox could
      // otherwise terminate an unrelated process during final stale cleanup.
      `kill -${signal} -- "-$pid" 2>/dev/null && exit 42`,
      "exit 0",
    ].join("; ");
    const h = await engine.exec({ containerId, cmd: ["sh", "-c", script] });
    return (await h.wait()) === 42;
  };

  const removePidFile = async () => {
    const h = await engine.exec({
      containerId,
      cmd: ["sh", "-c", `rm -f ${shSingleQuote(pidFile)}`],
    });
    await h.wait();
  };

  try {
    sawPidFile = await waitForPidFile();
    const signalled = await execCleanup("TERM");
    if (signalled) {
      await new Promise((r) => setTimeout(r, 3000));
      await execCleanup("KILL");
    }
    return signalled;
  } finally {
    if (sawPidFile || opts.removePidFileWhenMissing !== false) {
      await removePidFile().catch(() => {});
    }
  }
}

function createRealDriver(): SandboxDriver {
  return {
    async execRun(workspaceId, opts) {
      const { createOrReuse, providerKeyExecEnv, sandboxUser } = await import("./docker.js");
      const { detectEngine } = await import("./engine.js");
      const engine = await detectEngine();

      const handle = await createOrReuse(
        workspaceId,
        opts.workspaceSlug,
        opts.home,
        opts.providerKeys,
        undefined,
        opts.extraEnv,
      );

      // The system prompt — including the per-chat artifact paths and the
      // user's goal fragment — lives entirely in the OpenCode agent file
      // written by writeAgentFile, so the per-turn prompt is just the
      // user's text.
      const fullPrompt = opts.prompt;

      const runtime = selectedAgentRuntime();
      const runtimeModel = runtime === "pi"
        ? runtimeModelForPi(opts.model, opts.extraEnv)
        : opts.model;
      const cmd = runtime === "pi" ? buildPiCommand({
        runId: opts.runId,
        attachments: opts.attachments,
        model: runtimeModel,
        promptFile: opts.promptFile,
        systemPromptFile: opts.systemPromptFile,
      }) : buildOpencodeCommand({
        runId: opts.runId,
        agentFileId: opts.agentFileId,
        attachments: opts.attachments,
        model: runtimeModel,
        promptFile: opts.promptFile,
      });
      const pidFile = runPidFile(opts.runId);

      const handle$ = await engine.exec({
        containerId: handle.containerId,
        cmd,
        user: await sandboxUser(engine),
        env: [
          // Use a file reference when available so the prompt text never appears
          // in the execve env block, which is capped by ARG_MAX (~1 MB on macOS).
          ...(opts.promptFile
            ? [`DESK_PROMPT_FILE=${opts.promptFile}`]
            : [`DESK_PROMPT=${fullPrompt}`]),
          ...(opts.systemPromptFile ? [`DESK_PI_SYSTEM_PROMPT_FILE=${opts.systemPromptFile}`] : []),
          ...(opts.sandboxToken ? [`DESK_SANDBOX_TOKEN=${opts.sandboxToken}`] : []),
          ...(opts.apiUrl ? [`DESK_API_URL=${opts.apiUrl}`] : []),
          ...(opts.chatId ? [`DESK_CHAT_ID=${opts.chatId}`] : []),
          // Inject provider keys per-exec so a key added after the container
          // was created takes effect immediately without recreation. Missing
          // keys are cleared when a vault-backed map is supplied so warm
          // containers cannot keep using deleted/disabled connections.
          ...providerKeyExecEnv(opts.providerKeys, opts.extraEnv),
        ],
      });

      activeExecs.set(opts.runId, { containerId: handle.containerId, pidFile, execHandle: handle$ });

      let seq = 0;
      // The engine hands us already-demuxed stdout/stderr (the CLI
      // separates them when neither -t nor -T is in play). We track every
      // onLog return so the final resolve waits for async event appends to
      // commit — fast-exiting opencode runs (sub-second) would otherwise
      // race the stream 'end' against the last DB INSERTs and leave the
      // assistant-message write pointing at zero events.
      const pendingLogs: Promise<unknown>[] = [];
      let sawRuntimeFailureEvent = false;
      const emitLine = (kind: "stdout" | "stderr", text: string) => {
        if (!text) return;
        if (
          runtime === "pi" &&
          kind === "stdout" &&
          (text.includes('"stopReason":"error"') || text.includes('"stopReason":"aborted"'))
        ) {
          sawRuntimeFailureEvent = true;
        }
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
      const lineEmitter = createRuntimeLogLineEmitter(emitLine);
      handle$.stdout.on("data", (chunk: Buffer) => lineEmitter.ingest("stdout", chunk));
      handle$.stderr.on("data", (chunk: Buffer) => lineEmitter.ingest("stderr", chunk));

      try {
        const exitCode = await handle$.wait();
        lineEmitter.flush();
        await Promise.all(pendingLogs);
        return { exitCode: exitCode === 0 && sawRuntimeFailureEvent ? 1 : exitCode };
      } finally {
        activeExecs.delete(opts.runId);
        // Sweep the run's process group — opencode itself has exited (that's
        // what made `wait()` resolve), but its descendants (playwright-mcp +
        // firefox, npx wrappers, vite builds) may still be alive. Without
        // this, every run leaks zombies into the long-lived sandbox until
        // the container is recreated. We don't try to spare a still-alive
        // leader: if the host wrapper died mid-run, the output stream is
        // already gone, the work product is lost, and leaving the orphan
        // alive just creates double-spawn contention on the next fire.
        await cleanupRunProcessTree(engine, handle.containerId, pidFile, {
          // If cancelRun had to kill the docker/nerdctl wrapper before the
          // in-container shell wrote its pidfile, wait briefly here so the
          // final cleanup still has a chance to address the process group.
          waitForPidFileMs: 2000,
        }).catch(() => {});
      }
    },

    async cancelRun(runId) {
      const tracked = activeExecs.get(runId);
      if (!tracked) return;

      const { detectEngine } = await import("./engine.js");
      const engine = await detectEngine();

      try {
        const signalled = await cleanupRunProcessTree(engine, tracked.containerId, tracked.pidFile, {
          waitForPidFileMs: 2000,
          removePidFileWhenMissing: false,
        });
        if (!signalled) await tracked.execHandle.cancel();
      } catch {
        // Container may have stopped or exec already finished.
      } finally {
        activeExecs.delete(runId);
      }
    },
  };
}
