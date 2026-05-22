/**
 * Spawns pi (the @earendil-works/pi-coding-agent CLI) inside the sandbox
 * container for a single turn and streams its JSON event output back to
 * the host driver.
 *
 * Architecture vs. the old pi runtime:
 *
 *   - No long-lived daemon, no HTTP server, no SSE multiplexer, no port
 *     allocation, no MCP write lock, no env-digest restart, no auth wipe.
 *   - One `docker exec pi -p --mode json …` per turn. Pi reads/writes its
 *     own session files under `/home/agent/.pi/agent/sessions/`, which is
 *     the workspace bind-mount — so sessions survive container reaping
 *     and image upgrades for free.
 *   - Cancellation = SIGTERM to the exec wrapper + best-effort in-container
 *     `pkill -f pi` if the wrapper alone doesn't bring it down.
 *
 * The function accepts a per-event callback (translated run-format JSON
 * lines) and a stderr callback (raw log lines). The caller awaits the
 * returned promise; it resolves with the in-container exit code.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Engine } from "./engine.js";
import {
  type PiJsonEvent,
  modelSelectionFromEvent,
  readPiJsonEvents,
  terminalAssistantMessage,
  translatePiEvent,
  translateTerminalAssistantText,
  type TerminalAssistantMessage,
  type TranslateContext,
} from "./piEvents.js";
import { withModule } from "@agent-desk/shared/logger";
const log = withModule("runtime/piClient");
const PI_CLI_PATH = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

export interface PiRunOptions {
  containerId: string;
  /** `<uid>:<gid>` to run pi as inside the container. */
  user: string;
  /** Working directory inside the container; typically SANDBOX_HOME. */
  cwd: string;
  /**
   * Pi session id. Pi accepts arbitrary strings on `--session`; passing
   * the chat id keeps the session ↔ chat mapping deterministic across
   * turns, so subsequent turns automatically resume the prior context.
   */
  sessionId: string;
  /**
   * Host path to the bind-mounted pi session directory. Pi sometimes
   * persists the terminal assistant message there without echoing the
   * terminal event on stdout, leaving the CLI wrapper alive with MCP
   * children. Watching this path lets Desk finish the run as soon as the
   * authoritative session record says the turn is done.
   */
  hostSessionDir?: string;
  /** Provider id (anthropic, openai, openrouter, …). When omitted pi picks its default. */
  provider?: string;
  /** Model id (with or without provider prefix). When omitted pi picks its default. */
  model?: string;
  /**
   * Ordered model scope passed to pi's `--models` flag for its model
   * selector/cycling behavior. The runtime driver owns non-interactive
   * fallback retries between invocations.
   */
  models?: string[];
  /**
   * Env forwarded to pi. Provider keys (ANTHROPIC_API_KEY, …) land here.
   * Per-run env (sandbox token, DESK_API_URL) are also forwarded.
   */
  env: Record<string, string>;
  /** The single user prompt for this turn (already includes any attachment text parts). */
  prompt: string;
  /** Called once per translated run-format JSON event line. */
  onEvent: (line: string) => void | Promise<void>;
  /** Called once per stderr log line from pi (raw, not JSON-parsed). */
  onStderr: (line: string) => void | Promise<void>;
  /**
   * Context threaded into every translated event. Mirrors the pi
   * surfacing of sessionID + model annotation on each event so the chat
   * log can answer "what model produced this step?" without an extra
   * DB lookup.
   */
  translate: TranslateContext;
}

export interface PiRunResult {
  exitCode: number;
  /** True when cancel() ran (either via abort signal or external cancelRun). */
  aborted: boolean;
  /** Runtime model id from pi's terminal assistant message, when available. */
  model?: string;
}

/**
 * Tracks an in-flight pi invocation so cancelRun can find the right
 * subprocess and trigger an in-container kill if SIGTERM to the docker-
 * exec wrapper doesn't get the job done.
 */
export interface PiHandle {
  containerId: string;
  /** Resolves when the run finishes (success, error, or cancellation). */
  done: Promise<PiRunResult>;
  cancel(): Promise<void>;
}

interface PiDrainState {
  sawTextDelta: boolean;
  pending: Promise<unknown>[];
}

interface PiSessionTerminalWatcher {
  done: Promise<void>;
  stop(): void;
}

type PiChildProcess = ReturnType<typeof spawn> & {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
};

/**
 * Spawns pi as a foreground exec inside the container and returns a
 * handle. The caller awaits `handle.done` to learn the exit code.
 *
 * pi is invoked as:
 *
 *   node <pi-cli> -p --mode json --session=<id> [--provider <p>] [--model <m>] -- <prompt>
 *
 * `--` separates the positional prompt argv from any flags that take
 * values. The prompt itself is passed as a single argv element; Linux
 * argv accepts up to ~128 KB which is comfortably above any realistic
 * turn payload.
 */
export function runPi(engine: Engine, opts: PiRunOptions): PiHandle {
  const argv = buildPiArgv(opts);
  // Per-pi-invocation agent-dir on tmpfs (/tmp). Pi reads auth.json +
  // models.json from here and locks it via proper-lockfile. With two
  // parallel pi invocations sharing the workspace's ~/.pi/agent dir the
  // sync lockfile retry budget (200ms) is too short under load — some
  // invocations silently fall back to an empty auth and report "No API
  // key found" for the configured provider. Giving each pi its own
  // agent-dir eliminates the contention: pi never sees a contested
  // lock, so OAuth refresh + provider lookup always succeed.
  //
  // Sessions stay on the workspace bind-mount via the explicit
  // `--session-dir` flag (see buildPiArgv) so chat history still
  // persists across container reaping.
  const agentDir = `/tmp/pi-${randomUUID()}/agent`;
  const env = {
    HOME: opts.cwd,
    PI_CODING_AGENT_DIR: agentDir,
    ...opts.env,
  };
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  // Compose the seed-then-pi command inline as a shell script so we
  // get one `docker exec` per turn instead of two.
  //
  // Two seed sources, in priority order:
  //
  // 1. `PI_AUTH_JSON_BASE64` in env — base64-encoded auth.json
  //    written by the host-side local-source bridge (see
  //    `localSources/codex.ts` for the Codex/ChatGPT subscription path).
  //    This is the authoritative auth for OAuth providers; it gets
  //    refreshed per turn so a refresh on the host (or pi-side) is
  //    picked up immediately.
  //
  // 2. Workspace-side `~/.pi/agent/auth.json` + `models.json` — files
  //    a user / a skill may have written into their workspace (e.g.
  //    a hand-crafted models.json defining custom Ollama or vLLM
  //    providers). These get copied into the per-invocation dir so
  //    pi can use them alongside the env-injected OAuth blob.
  //
  // The base64 decode happens last so the env auth always wins over
  // a stale workspace-side file.
  const piCmd = argv.map(shSingleQuote).join(" ");
  const sourceDir = `${opts.cwd}/.pi/agent`;
  const seedSteps: string[] = [
    `mkdir -p ${shSingleQuote(agentDir)}`,
    `cp ${shSingleQuote(`${sourceDir}/auth.json`)} ${shSingleQuote(`${sourceDir}/models.json`)} ${shSingleQuote(agentDir)}/ 2>/dev/null || true`,
    // Pi auto-discovers extensions in $PI_CODING_AGENT_DIR/extensions/<name>/
    // index.ts. Because we override PI_CODING_AGENT_DIR to a fresh tmpfs
    // dir per invocation (for lockfile-contention reasons above), we need
    // to seed the bundled extensions too — otherwise the desk-mcp-bridge
    // (and any future bundled extension) is invisible to pi, MCP servers
    // never spawn, and tools like playwright never reach the agent.
    //
    // /etc/skel is the image-side source of truth. The workspace-side
    // copy at $sourceDir/extensions is also a valid place for users to
    // drop their own extensions; we overlay it on top so user extensions
    // can coexist with the bundled ones (user copy wins for same name).
    `mkdir -p ${shSingleQuote(`${agentDir}/extensions`)}`,
    `cp -r /etc/skel/.pi/agent/extensions/. ${shSingleQuote(`${agentDir}/extensions`)}/ 2>/dev/null || true`,
    `cp -r ${shSingleQuote(`${sourceDir}/extensions`)}/. ${shSingleQuote(`${agentDir}/extensions`)}/ 2>/dev/null || true`,
  ];
  // Only emit the env-auth seed step when the env var is non-empty; an
  // empty value just clears the workspace-side file.
  if (opts.env.PI_AUTH_JSON_BASE64) {
    seedSteps.push(
      `printf '%s' "$PI_AUTH_JSON_BASE64" | base64 -d > ${shSingleQuote(`${agentDir}/auth.json`)} && chmod 600 ${shSingleQuote(`${agentDir}/auth.json`)}`,
    );
  }
  seedSteps.push(`exec ${piCmd}`);
  const shellScript = seedSteps.join(" && ");
  const dockerArgv = [
    "exec",
    "-i",
    "--user", opts.user,
    "--workdir", opts.cwd,
    ...envArgs,
    opts.containerId,
    "sh", "-c", shellScript,
  ];

  const drainState: PiDrainState = { sawTextDelta: false, pending: [] };
  let aborted = false;
  let killScheduled = false;
  let terminalExitCode: number | undefined;
  let terminalModel: string | undefined;
  let terminalCleanupKillScheduled = false;
  const child = spawn(engine.name, dockerArgv, { stdio: ["ignore", "pipe", "pipe"] }) as PiChildProcess;

  const scheduleTerminalCleanupKill = () => {
    if (terminalCleanupKillScheduled) return;
    terminalCleanupKillScheduled = true;
    setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {/* noop */}
      void cleanupPiInvocation(engine, opts, agentDir);
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {/* noop */}
        void cleanupPiInvocation(engine, opts, agentDir, "KILL");
      }, 2000).unref();
    }, 100).unref();
  };

  const handleTerminal = (terminal: TerminalAssistantMessage) => {
    terminalExitCode ??= terminal.exitCode;
    if (terminal.model) {
      terminalModel = `${terminal.model.providerID}/${terminal.model.modelID}`;
    }
    scheduleTerminalCleanupKill();
  };
  const sessionWatcher = opts.hostSessionDir
    ? watchPiSessionTerminal(opts.hostSessionDir, (evt) => {
        processPiJsonEvent(evt, opts, drainState, handleTerminal);
      })
    : null;
  const stderrPromise = drainStderr(child.stderr, opts.onStderr);
  const stdoutPromise = drainStdoutEvents(child.stdout, opts, drainState, handleTerminal);

  const done = new Promise<PiRunResult>((resolve) => {
    child.on("exit", async (code, signal) => {
      sessionWatcher?.stop();
      try {
        await Promise.all([
          stdoutPromise,
          stderrPromise,
          ...(sessionWatcher ? [sessionWatcher.done] : []),
          ...drainState.pending,
        ]);
      } catch (err) {
        log.warn({ err: (err as Error)?.message }, "piClient: drain failed");
      }
      await cleanupPiInvocation(engine, opts, agentDir).catch((err) => {
        log.warn({ err: (err as Error)?.message }, "piClient: cleanup failed");
      });
      const exitCode = terminalExitCode ?? (typeof code === "number" ? code : signal ? 130 : 1);
      resolve({ exitCode, aborted, ...(terminalModel ? { model: terminalModel } : {}) });
    });
    child.on("error", async (err) => {
      sessionWatcher?.stop();
      try {
        await Promise.all([
          stdoutPromise,
          stderrPromise,
          ...(sessionWatcher ? [sessionWatcher.done] : []),
          ...drainState.pending,
        ]);
      } catch {/* noop */}
      await opts.onStderr(`pi spawn failed: ${err.message}`);
      resolve({ exitCode: 1, aborted, ...(terminalModel ? { model: terminalModel } : {}) });
    });
  });

  const cancel = async (): Promise<void> => {
    if (killScheduled) return;
    killScheduled = true;
    aborted = true;
    // SIGTERM the wrapper; if pi survives (rare — it forwards signals),
    // a best-effort in-container pkill brings it down so the next turn
    // doesn't race against a zombie.
    try { child.kill("SIGTERM"); } catch {/* noop */}
    void cleanupPiInvocation(engine, opts, agentDir);
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {/* noop */}
      void cleanupPiInvocation(engine, opts, agentDir, "KILL");
    }, 2000).unref();
  };

  return { containerId: opts.containerId, done, cancel };
}

async function cleanupPiInvocation(
  engine: Engine,
  opts: PiRunOptions,
  agentDir: string,
  signal: "TERM" | "KILL" = "TERM",
): Promise<void> {
  const script = [
    "set +e",
    "targets=''",
    "for envfile in /proc/[0-9]*/environ; do",
    "  pid=${envfile#/proc/}; pid=${pid%/environ}",
    "  if tr '\\0' '\\n' < \"$envfile\" 2>/dev/null | grep -Fxq \"PI_CODING_AGENT_DIR=$PI_TARGET_AGENT_DIR\"; then",
    "    targets=\"$targets $pid\"",
    "  fi",
    "done",
    "if [ -n \"$targets\" ]; then",
    `  kill -${signal} $targets 2>/dev/null || true`,
    "fi",
    "exit 0",
  ].join("\n");
  const cleanup = await engine.exec({
    containerId: opts.containerId,
    user: opts.user,
    env: [`PI_TARGET_AGENT_DIR=${agentDir}`],
    cmd: ["sh", "-c", script],
  });
  await cleanup.wait();
}

/** POSIX-quote `s` for safe inclusion inside `sh -c '…'`. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildPiArgv(opts: PiRunOptions): string[] {
  // pi treats `--session <id>` as "resume existing session by id" — it
  // errors out with "No session found" when the id is unknown, so we
  // can't use it to seed a chat's id on the first turn. Instead give
  // each chat its own session-dir under the workspace and use
  // `--continue` to resume; on the very first turn the dir is empty
  // and pi auto-creates a fresh session there, then every subsequent
  // turn continues it.
  //
  // The session dir sits inside SANDBOX_HOME (the workspace bind
  // mount) so chat history survives container reaping for free.
  const argv: string[] = ["node", PI_CLI_PATH, "-p", "--mode", "json"];
  if (opts.sessionId) {
    argv.push("--session-dir", `/home/agent/.pi/agent/sessions/${opts.sessionId}`);
    argv.push("--continue");
  }
  if (opts.provider) argv.push("--provider", opts.provider);
  if (opts.model) argv.push("--model", opts.model);
  if (opts.models?.length) argv.push("--models", opts.models.join(","));
  argv.push(opts.prompt);
  return argv;
}

async function drainStdoutEvents(
  stdout: NodeJS.ReadableStream,
  opts: PiRunOptions,
  state: PiDrainState,
  onTerminal?: (message: TerminalAssistantMessage) => void,
): Promise<void> {
  for await (const evt of readPiJsonEvents(stdout as unknown as AsyncIterable<Uint8Array>, {
    onParseError: (raw, err) => {
      void opts.onStderr(`pi: unparseable JSON event: ${raw.slice(0, 200)} (${(err as Error).message})`);
    },
  })) {
    processPiJsonEvent(evt, opts, state, onTerminal);
  }
}

function processPiJsonEvent(
  evt: PiJsonEvent,
  opts: PiRunOptions,
  state: PiDrainState,
  onTerminal?: (message: TerminalAssistantMessage) => void,
): void {
  const selectedModel = modelSelectionFromEvent(evt);
  if (selectedModel) {
    opts.translate.model = {
      ...selectedModel,
      ...(opts.translate.model?.agent ? { agent: opts.translate.model.agent } : {}),
    };
  }
  const translated = translatePiEvent(evt, opts.translate);
  if (translated.some((line) => {
    try {
      return (JSON.parse(line) as { type?: unknown }).type === "text";
    } catch {
      return false;
    }
  })) {
    state.sawTextDelta = true;
  }
  const terminal = terminalAssistantMessage(evt);
  if (terminal) {
    if (terminal.model) {
      opts.translate.model = {
        ...terminal.model,
        ...(opts.translate.model?.agent ? { agent: opts.translate.model.agent } : {}),
      };
    }
    if (terminal.errorMessage) {
      trackAsync(state, opts.onStderr(terminal.errorMessage));
    } else if (!state.sawTextDelta) {
      translated.push(...translateTerminalAssistantText(evt, opts.translate));
      state.sawTextDelta = terminal.text.length > 0;
    }
    onTerminal?.(terminal);
  }
  for (const line of translated) {
    trackAsync(state, opts.onEvent(line));
  }
}

function trackAsync(state: PiDrainState, ret: void | Promise<void>): void {
  if (ret && typeof (ret as Promise<unknown>).then === "function") {
    state.pending.push((ret as Promise<unknown>).catch(() => {}));
  }
}

export function watchPiSessionTerminal(
  sessionDir: string,
  onTerminalEvent: (evt: PiJsonEvent) => void | Promise<void>,
  opts: {
    pollMs?: number;
    successGraceMs?: number;
    errorGraceMs?: number;
  } = {},
): PiSessionTerminalWatcher {
  const pollMs = opts.pollMs ?? 250;
  const successGraceMs = opts.successGraceMs ?? 250;
  const errorGraceMs = opts.errorGraceMs
    ?? parseInt(process.env.DESK_PI_TERMINAL_ERROR_GRACE_MS ?? "12000", 10);
  const offsets = new Map<string, number>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let polling = false;
  let pendingTerminal: { evt: PiJsonEvent; dueAt: number } | null = null;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    resolveDone();
  };

  const emit = async (evt: PiJsonEvent): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      await onTerminalEvent(evt);
    } finally {
      resolveDone();
    }
  };

  const schedule = (): void => {
    if (stopped || polling) return;
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, pollMs);
    timer.unref?.();
  };

  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      const now = Date.now();
      const files = await listJsonlFiles(sessionDir);
      for (const file of files) {
        const stat = await fs.stat(file).catch(() => null);
        if (!stat) continue;
        const prev = offsets.get(file) ?? 0;
        const offset = stat.size < prev ? 0 : prev;
        offsets.set(file, stat.size);
        if (stat.size <= offset) continue;
        const chunk = await readFileSlice(file, offset, stat.size - offset).catch(() => "");
        for (const line of chunk.split(/\r?\n/)) {
          const evt = parseSessionJsonLine(line);
          if (!evt) continue;
          const terminal = terminalAssistantMessage(evt);
          if (!terminal) {
            // A later event means pi is still active after a transient
            // error record, so let its own retry loop continue.
            if (pendingTerminal?.evt && isErrorTerminal(pendingTerminal.evt)) {
              pendingTerminal = null;
            }
            continue;
          }
          const graceMs = terminal.exitCode === 0 ? successGraceMs : errorGraceMs;
          pendingTerminal = { evt, dueAt: Date.now() + graceMs };
        }
      }
      if (pendingTerminal && now >= pendingTerminal.dueAt) {
        await emit(pendingTerminal.evt);
        return;
      }
    } catch (err) {
      log.warn({ err: (err as Error)?.message, sessionDir }, "piClient: session terminal watcher failed");
      stop();
      return;
    } finally {
      polling = false;
    }
    schedule();
  };

  for (const file of listJsonlFilesSync(sessionDir)) {
    const stat = safeStatSync(file);
    if (stat) offsets.set(file, stat.size);
  }
  schedule();

  return { done, stop };
}

function isErrorTerminal(evt: PiJsonEvent): boolean {
  const terminal = terminalAssistantMessage(evt);
  return terminal?.exitCode === 1;
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [];
      throw err;
    });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out.sort();
}

function listJsonlFilesSync(dir: string): string[] {
  const out: string[] = [];
  function walk(current: string): void {
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out.sort();
}

function safeStatSync(file: string): fsSync.Stats | null {
  try {
    return fsSync.statSync(file);
  } catch {
    return null;
  }
}

async function readFileSlice(file: string, start: number, length: number): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseSessionJsonLine(line: string): PiJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string"
      ? parsed as PiJsonEvent
      : null;
  } catch {
    return null;
  }
}

async function drainStderr(
  stderr: NodeJS.ReadableStream,
  onStderr: PiRunOptions["onStderr"],
): Promise<void> {
  const pending: Promise<unknown>[] = [];
  let buffer = "";
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of stderr as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const ret = onStderr(line);
      if (ret && typeof (ret as Promise<unknown>).then === "function") {
        pending.push((ret as Promise<unknown>).catch(() => {}));
      }
    }
  }
  if (buffer.trim()) {
    const ret = onStderr(buffer);
    if (ret && typeof (ret as Promise<unknown>).then === "function") {
      pending.push((ret as Promise<unknown>).catch(() => {}));
    }
  }
  if (pending.length > 0) await Promise.all(pending);
}
