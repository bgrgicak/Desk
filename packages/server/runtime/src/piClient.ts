/**
 * Spawns pi (the @earendil-works/pi-coding-agent CLI) inside the sandbox
 * container for a single turn and streams its JSON event output back to
 * the host driver.
 *
 * Architecture vs. the old opencode-serve daemon:
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
import type { Engine } from "./engine.js";
import { readPiJsonEvents, translatePiEvent, type TranslateContext } from "./piEvents.js";
import { withModule } from "@agent-desk/shared/logger";
const log = withModule("runtime/piClient");

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
  /** Provider id (anthropic, openai, openrouter, …). When omitted pi picks its default. */
  provider?: string;
  /** Model id (with or without provider prefix). When omitted pi picks its default. */
  model?: string;
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
   * Context threaded into every translated event. Mirrors the opencode
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

/**
 * Spawns pi as a foreground exec inside the container and returns a
 * handle. The caller awaits `handle.done` to learn the exit code.
 *
 * pi is invoked as:
 *
 *   pi -p --mode json --session=<id> [--provider <p>] [--model <m>] -- <prompt>
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
  // Compose the seed-then-pi command inline as a shell script so we get
  // one `docker exec` per turn instead of two. The seed copies auth.json
  // + models.json from the workspace's ~/.pi/agent (where the entrypoint
  // already placed them from /etc/skel) into the per-invocation dir.
  // Pi then runs against the isolated dir.
  const piCmd = argv.map(shSingleQuote).join(" ");
  const sourceDir = `${opts.cwd}/.pi/agent`;
  const shellScript = [
    `mkdir -p ${shSingleQuote(agentDir)}`,
    `cp ${shSingleQuote(`${sourceDir}/auth.json`)} ${shSingleQuote(`${sourceDir}/models.json`)} ${shSingleQuote(agentDir)}/ 2>/dev/null || true`,
    `exec ${piCmd}`,
  ].join(" && ");
  const dockerArgv = [
    "exec",
    "-i",
    "--user", opts.user,
    "--workdir", opts.cwd,
    ...envArgs,
    opts.containerId,
    "sh", "-c", shellScript,
  ];

  const child = spawn(engine.name, dockerArgv, { stdio: ["ignore", "pipe", "pipe"] });
  let aborted = false;
  let killScheduled = false;

  const stderrPromise = drainStderr(child.stderr, opts.onStderr);
  const stdoutPromise = drainStdoutEvents(child.stdout, opts);

  const done = new Promise<PiRunResult>((resolve) => {
    child.on("exit", async (code, signal) => {
      try {
        await Promise.all([stdoutPromise, stderrPromise]);
      } catch (err) {
        log.warn({ err: (err as Error)?.message }, "piClient: drain failed");
      }
      const exitCode = typeof code === "number" ? code : signal ? 130 : 1;
      resolve({ exitCode, aborted });
    });
    child.on("error", async (err) => {
      try {
        await Promise.all([stdoutPromise, stderrPromise]);
      } catch {/* noop */}
      await opts.onStderr(`pi spawn failed: ${err.message}`);
      resolve({ exitCode: 1, aborted });
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
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {/* noop */}
    }, 2000).unref();
    try {
      const killHandle = await engine.exec({
        containerId: opts.containerId,
        user: opts.user,
        cmd: ["sh", "-c", "pkill -TERM -f 'pi ' 2>/dev/null || true; sleep 0.5; pkill -KILL -f 'pi ' 2>/dev/null || true; exit 0"],
      });
      await killHandle.wait();
    } catch {/* best-effort */}
  };

  return { containerId: opts.containerId, done, cancel };
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
  const argv: string[] = ["pi", "-p", "--mode", "json"];
  if (opts.sessionId) {
    argv.push("--session-dir", `/home/agent/.pi/agent/sessions/${opts.sessionId}`);
    argv.push("--continue");
  }
  if (opts.provider) argv.push("--provider", opts.provider);
  if (opts.model) argv.push("--model", opts.model);
  argv.push(opts.prompt);
  return argv;
}

async function drainStdoutEvents(
  stdout: NodeJS.ReadableStream,
  opts: PiRunOptions,
): Promise<void> {
  const pending: Promise<unknown>[] = [];
  for await (const evt of readPiJsonEvents(stdout as unknown as AsyncIterable<Uint8Array>, {
    onParseError: (raw, err) => {
      void opts.onStderr(`pi: unparseable JSON event: ${raw.slice(0, 200)} (${(err as Error).message})`);
    },
  })) {
    for (const line of translatePiEvent(evt, opts.translate)) {
      const ret = opts.onEvent(line);
      if (ret && typeof (ret as Promise<unknown>).then === "function") {
        pending.push((ret as Promise<unknown>).catch(() => {}));
      }
    }
  }
  if (pending.length > 0) await Promise.all(pending);
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
