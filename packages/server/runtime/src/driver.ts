/**
 * Sandbox driver — spawns pi (@earendil-works/pi-coding-agent) inside the
 * workspace's container for one turn and streams its JSON events back as
 * run-format JSON lines.
 *
 * One sandbox container per workspace; one pi subprocess per turn; pi's
 * own session files (under `/home/agent/.pi/agent/sessions/`) live on
 * the workspace bind-mount, so turns within a chat resume automatically
 * by passing `--session=<chatId>`. No daemon, no HTTP, no SSE, no MCP
 * write lock, no env-digest dance — every turn is a clean invocation.
 *
 * Event flow:
 *   1. `execRun` ensures the container is up and pre-creates per-run
 *      mounts (handled upstream by `execRun.ts`).
 *   2. Spawns pi via `docker exec`, with the chat session id, provider,
 *      model, and a single text prompt (prompt + attachment references).
 *   3. Pi emits JSON events line-by-line on stdout; the driver translates
 *      each via `piEvents.ts` into the existing run-format JSON shape and
 *      surfaces them through `onLog`.
 *   4. Stderr lines are surfaced as `kind: "stderr"`.
 *   5. The exec resolves when pi exits; cancellation is `cancelRun(runId)`
 *      which calls `handle.cancel()` (SIGTERM + best-effort in-container
 *      pkill).
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { SANDBOX_HOME, type MountPlan } from "./mounts.js";
import { managedConnectionDefinitions } from "@roomy-ai/shared";
import { connectionEnvNames } from "./docker.js";
import { LOCAL_SOURCE_ENV_NAMES } from "./localSources/index.js";
import { runPi, type PiHandle } from "./piClient.js";
import { withModule } from "@roomy-ai/shared/logger";
const log = withModule("runtime/driver");

export interface RunOptions {
  runId: string;
  prompt: string;
  agentFileId?: string;
  /**
   * Workspace-relative paths the user attached to this message. The
   * driver folds each file's reference into the prompt as additional
   * text, telling the agent to read it.
   */
  attachments?: string[];
  /** On-disk slug for the workspace this run belongs to. */
  workspaceSlug: string;
  /** Chat this run belongs to. Used as pi's session id for cross-turn context. */
  chatId?: string;
  /** ROOMY_HOME root. When omitted, runtime storage resolution is used. */
  home?: string;
  mountPlan?: MountPlan;
  /**
   * Pi session id for the chat. Threaded in so the runtime stays
   * DB-agnostic; when undefined the driver derives one from `chatId`
   * (chat-scoped runs) or generates a UUID (ad-hoc runs).
   */
  piSessionId?: string | null;
  /**
   * Called once per stdout/stderr/event log line. May be sync or async —
   * the driver tracks any returned promise and awaits all of them before
   * resolving `execRun`.
   */
  onLog: (event: LogEvent) => void | Promise<void>;
  /**
   * Model id, e.g. "anthropic/claude-haiku-4-5". The driver splits this
   * on the first slash into provider/model for pi. When omitted, pi picks
   * its default.
   */
  model?: string;
  /**
   * Ordered fallback model ids. The driver tries the primary and these
   * fallbacks in order. Pi also receives the remaining scope for model
   * cycling/selection, but non-interactive error fallback is owned here.
   */
  modelFallbacks?: string[];
  /**
   * Provider API keys forwarded into the pi process env. Per-turn, so a
   * provider change in Settings reaches the next turn without any
   * supervisor restart.
   */
  providerKeys?: Record<string, string>;
  /** Non-key env vars forwarded into pi. */
  extraEnv?: Record<string, string>;
  /**
   * Per-run sandbox session token. Written to a fixed in-container path
   * before each turn; the in-sandbox `roomy-agent` CLI reads it from there.
   */
  sandboxToken?: string;
  /** URL the in-sandbox `roomy-agent` CLI POSTs to. */
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
  /**
   * Session id used to handle this run. The caller persists this back
   * onto the chat row so subsequent turns reuse the same pi session.
   * Always populated unless the run failed before pi was invoked.
   */
  piSessionId?: string;
  /** Runtime model id that handled the successful attempt, or the last failed attempt. */
  model?: string;
}

export interface SandboxDriver {
  execRun(workspaceId: string, opts: RunOptions): Promise<ExecResult>;
  cancelRun(runId: string): Promise<void>;
}

export function createDriver(): SandboxDriver {
  if (process.env.ROOMY_SANDBOX_DRIVER === "fake") {
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
        ...(process.env.ROOMY_FAKE_DRIVER_LOG_PROVIDER_KEYS === "1"
          ? [`Provider keys: ${Object.keys(opts.providerKeys ?? {}).sort().join(",") || "none"}`]
          : []),
        `Processing prompt: ${opts.prompt.slice(0, 50)}...`,
        "Fake response generated.",
        "Run complete.",
      ];

      const stepDelayMs = parseInt(process.env.ROOMY_FAKE_DRIVER_STEP_DELAY_MS ?? "10", 10);
      let seq = 0;
      for (const line of lines) {
        if (cancelled.has(runId)) {
          return { exitCode: 130 };
        }
        await onLog({ runId, seq: seq++, kind: "stdout", payload: line });
        await new Promise((r) => setTimeout(r, stepDelayMs));
      }

      return {
        exitCode: 0,
        piSessionId: opts.piSessionId ?? `fake_session_${runId}`,
        model: opts.model,
      };
    },

    async cancelRun(runId) {
      cancelled.add(runId);
    },
  };
}

/** Maps `<workspace-relative>` → in-sandbox absolute path. */
export function toSandboxPath(rel: string): string {
  return `${SANDBOX_HOME}/${rel.replace(/^\/+/, "")}`;
}

/**
 * Splits a model string like "anthropic/claude-haiku-4-5" into
 * `{providerID, modelID}`. Falls back to no provider when the input has
 * no slash (pi infers from the model id in that case).
 *
 * `codex/<name>` is a Roomy-only UI relabel for OpenAI models authed via
 * the ChatGPT/Codex bridge. Pi exposes those under the `openai-codex`
 * provider id (separate from `openai`, which requires an API key), so
 * translate the UI's `codex/` prefix back to pi's `openai-codex` for runs.
 */
export function parseModelSpec(model: string): { providerID?: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) return { modelID: model };
  const provider = model.slice(0, slash);
  return {
    providerID: provider === "codex" ? "openai-codex" : provider,
    modelID: model.slice(slash + 1),
  };
}

export function modelAttemptSpecs(
  model?: string,
  modelFallbacks?: string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [model, ...(modelFallbacks ?? [])]) {
    const trimmed = candidate?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function piModelReference(model: string): string {
  const parsed = parseModelSpec(model);
  return parsed.providerID ? `${parsed.providerID}/${parsed.modelID}` : parsed.modelID;
}

/**
 * Builds the single prompt string pi receives for a turn. Folds attachment
 * references in as additional sentences so the agent knows what files to
 * read; pi has no separate "parts" concept, so everything goes inline.
 */
export function buildPiPrompt(opts: { prompt: string; attachments?: string[] }): string {
  if (!opts.attachments || opts.attachments.length === 0) return opts.prompt;
  const lines = [opts.prompt, ""];
  for (const rel of opts.attachments) {
    const absPath = toSandboxPath(rel);
    lines.push(`Attachment: ${absPath} — read this file from the workspace before answering.`);
  }
  return lines.join("\n");
}

interface ActiveRun {
  containerId: string;
  sessionId: string;
  handle: PiHandle;
}
const activeRuns = new Map<string, ActiveRun>();

/** Test-only: drops in-flight tracking without touching containers. */
export function _resetActiveRunsForTest(): void {
  activeRuns.clear();
}

/**
 * Returns true if any run is currently in flight on the given container.
 * Used by the connection-refresh path to skip workspaces with an active
 * run — every turn is its own pi process so we can't safely tear the
 * container down mid-call.
 */
export function hasActiveRunForContainer(containerId: string): boolean {
  for (const entry of activeRuns.values()) {
    if (entry.containerId === containerId) return true;
  }
  return false;
}

function createRealDriver(): SandboxDriver {
  return {
    async execRun(workspaceId, opts) {
      const { createOrReuse, sandboxUser } = await import("./docker.js");
      const { detectEngine } = await import("./engine.js");
      const engine = await detectEngine();

      const acquireHandle = () =>
        createOrReuse(
          workspaceId,
          opts.workspaceSlug,
          opts.home,
          opts.providerKeys,
          opts.mountPlan,
          opts.extraEnv,
        );

      const user = await sandboxUser(engine);
      const piEnv = buildPiEnv({
        providerKeys: opts.providerKeys,
        extraEnv: opts.extraEnv,
        apiUrl: opts.apiUrl,
        runId: opts.runId,
      });

      const tokenPath = sandboxTokenPath(opts.runId);

      const acquireReadyHandle = async (): Promise<Awaited<ReturnType<typeof acquireHandle>>> => {
        // createOrReuse can throw with a container-gone error if the
        // container is removed during its waitForEntrypointReady poll
        // (reaper / drift recreate / parallel fire / rm -f). A single
        // retry covers the race; persistent failures still bubble up.
        let nextHandle: Awaited<ReturnType<typeof acquireHandle>>;
        try {
          nextHandle = await acquireHandle();
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          if (!isContainerGoneError(msg)) throw err;
          nextHandle = await acquireHandle();
        }

        // Write the per-run sandbox token to a per-run in-container path
        // before invoking pi. The in-sandbox `roomy-agent` CLI reads from
        // this path when ROOMY_SANDBOX_TOKEN isn't set in its env.
        //
        // A per-run path is required because the container is shared
        // across all runs in the same workspace. With a single fixed
        // path, concurrent runs would overwrite each other's token; when
        // the run that won the write finished and revoked its token,
        // the still-running run's CLI calls would inherit the revoked
        // token and fail with UNAUTHORIZED.
        //
        // The write must succeed — a stale or missing token file means
        // every in-sandbox API call will fail. We let the error bubble
        // out so the scheduler marks the run failed up front rather
        // than producing a half-functional turn.
        if (opts.sandboxToken) {
          await writeSandboxTokenFile(engine, nextHandle.containerId, user, tokenPath, opts.sandboxToken);
        }
        return nextHandle;
      };

      const handle = await acquireReadyHandle();

      const sessionId = opts.piSessionId ?? opts.chatId ?? randomUUID();

      let seq = 0;
      const pendingLogs: Promise<unknown>[] = [];
      const emitLog = (kind: LogEvent["kind"], payload: string) => {
        const ret = opts.onLog({ runId: opts.runId, seq: seq++, kind, payload });
        if (ret && typeof (ret as Promise<unknown>).then === "function") {
          pendingLogs.push((ret as Promise<unknown>).catch(() => {}));
        }
      };

      try {
        const modelScope = modelAttemptSpecs(opts.model, opts.modelFallbacks)
          .map(piModelReference);
        const modelAttempts: Array<string | undefined> = modelScope.length > 0 ? modelScope : [undefined];
        const prompt = buildPiPrompt({ prompt: opts.prompt, attachments: opts.attachments });
        const hostSessionDir = opts.home
          ? path.join(opts.home, opts.workspaceSlug, ".pi", "agent", "sessions", sessionId)
          : undefined;

        let lastResult: ExecResult | undefined;
        for (let attemptIndex = 0; attemptIndex < modelAttempts.length; attemptIndex++) {
          const attemptModel = modelAttempts[attemptIndex];
          const parsed = attemptModel ? parseModelSpec(attemptModel) : undefined;
          const providerID = parsed?.providerID;
          const modelID = parsed?.modelID;
          const remainingScope = modelScope.slice(attemptIndex);

          const piHandle = runPi(engine, {
            containerId: handle.containerId,
            user,
            cwd: SANDBOX_HOME,
            sessionId,
            hostSessionDir,
            provider: providerID,
            model: modelID,
            models: remainingScope.length > 0 ? remainingScope : undefined,
            env: piEnv,
            prompt,
            onEvent: (line) => emitLog("event", line),
            onStderr: (line) => emitLog("stderr", line),
            translate: {
              sessionID: sessionId,
              assistantMessageId: `msg_${opts.runId}`,
              ...(providerID && modelID
                ? { model: { providerID, modelID, ...(opts.agentFileId ? { agent: opts.agentFileId } : {}) } }
                : {}),
            },
          });
          activeRuns.set(opts.runId, { containerId: handle.containerId, sessionId, handle: piHandle });
          const result = await piHandle.done;
          activeRuns.delete(opts.runId);
          const exitCode = result.aborted ? 130 : result.exitCode;
          const handledModel = result.model ?? attemptModel;
          lastResult = {
            exitCode,
            piSessionId: sessionId,
            model: handledModel,
          };

          await Promise.all(pendingLogs);

          if (exitCode === 0 || exitCode === 130 || attemptIndex === modelAttempts.length - 1) {
            return lastResult;
          }

          const nextModel = modelAttempts[attemptIndex + 1];
          if (!nextModel) return lastResult;
          emitLog(
            "stderr",
            `Model ${handledModel ?? attemptModel ?? "default"} failed with exit ${exitCode}; trying fallback ${nextModel}.`,
          );
        }

        await Promise.all(pendingLogs);
        return lastResult ?? { exitCode: 1, piSessionId: sessionId };
      } finally {
        activeRuns.delete(opts.runId);
        if (opts.sandboxToken) {
          // Per-run path: drop the file so /tmp doesn't accumulate one
          // entry per run for the life of the workspace container. The
          // token is revoked in the DB regardless; this is purely
          // hygiene. Best-effort — if the container is already gone,
          // the file is gone with it.
          await cleanupSandboxTokenFile(engine, handle.containerId, user, tokenPath).catch(
            (err) => log.warn({ runId: opts.runId, err: (err as Error)?.message }, "sandbox token cleanup failed"),
          );
        }
      }
    },

    async cancelRun(runId) {
      const tracked = activeRuns.get(runId);
      if (!tracked) return;
      try {
        await tracked.handle.cancel();
      } catch {
        // Best-effort: if pi already exited, the cancel races the
        // child-exit handler — either order leaves nothing further to do.
      }
    },
  };
}

/**
 * Per-run path for the sandbox session token inside the container.
 *
 * The container is shared across all runs in the same workspace, so
 * using a single fixed path (e.g. `/tmp/roomy-sandbox-token`) lets
 * concurrent runs stomp each other's token. When the run that won the
 * write finished and revoked its token, the still-running run's
 * roomy-agent CLI calls would read the now-revoked token and the API
 * would return UNAUTHORIZED. Keying the path on runId eliminates that
 * cross-run sharing.
 */
export function sandboxTokenPath(runId: string): string {
  return `/tmp/roomy-sandbox-token-${runId}`;
}

/**
 * Match the failures that mean "this attempt needs a fresh container,
 * not retry on the existing one". The underlying container engine
 * produces the same strings regardless of which agent runtime we use.
 */
export function isContainerGoneError(message: string): boolean {
  return (
    /no such (container|object)/i.test(message) ||
    /container .* (not found|is not running)/i.test(message) ||
    /ensure timed out after/i.test(message)
  );
}

async function writeSandboxTokenFile(
  engine: import("./engine.js").Engine,
  containerId: string,
  user: string,
  tokenPath: string,
  token: string,
): Promise<void> {
  // POSIX-quote the token so any odd characters can't break the shell
  // expression. Real tokens are hex strings, but stay defensive.
  const quoted = `'${token.replace(/'/g, `'\\''`)}'`;
  const h = await engine.exec({
    containerId,
    user,
    cmd: [
      "sh", "-c",
      [
        `umask 077`,
        `printf '%s' ${quoted} > ${tokenPath}`,
      ].join(" && "),
    ],
  });
  const code = await h.wait();
  if (code !== 0) {
    throw new Error(`sandbox token write exited ${code}`);
  }
}

async function cleanupSandboxTokenFile(
  engine: import("./engine.js").Engine,
  containerId: string,
  user: string,
  tokenPath: string,
): Promise<void> {
  const h = await engine.exec({
    containerId,
    user,
    cmd: ["rm", "-f", tokenPath],
  });
  await h.wait();
}

/**
 * Mirror managed-connection aliases from their canonical envKey so pi
 * sees both names with the same value. Matches the per-exec
 * `providerKeyExecEnv` semantics: e.g. if Settings stores `GITHUB_TOKEN`,
 * `GH_TOKEN` is emitted alongside with the same value so the agent's git
 * tool calls authenticate regardless of which name they check.
 */
function buildManagedConnectionAliases(
  providerKeys?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (!providerKeys) return env;
  for (const definition of managedConnectionDefinitions()) {
    const value = providerKeys[definition.envKey];
    if (!value || value.length === 0) continue;
    for (const alias of definition.envAliases ?? []) {
      env[alias] = value;
    }
  }
  return env;
}

/**
 * Assembles the pi process env. Disabled provider/connection vars are
 * emitted as empty strings, not omitted: pi inherits the container's
 * birth env via `docker exec`, and an explicit `-e KEY=` overrides
 * whatever value was baked in at container create time. Toggling a
 * provider off in Settings genuinely hides it from pi rather than
 * leaking through the container birth env.
 *
 * Exported for direct unit testing.
 */
export function buildPiEnv(opts: {
  providerKeys?: Record<string, string>;
  extraEnv?: Record<string, string>;
  apiUrl?: string;
  /**
   * Run id used to derive the per-run sandbox token path. Omitted by
   * non-run callers (e.g. connection-refresh env-digest computation),
   * which don't use the token at all.
   */
  runId?: string;
}): Record<string, string> {
  const blanks: Record<string, string> = {};
  for (const name of connectionEnvNames()) blanks[name] = "";
  for (const name of LOCAL_SOURCE_ENV_NAMES) blanks[name] = "";

  return {
    ...blanks,
    ...(opts.providerKeys ?? {}),
    ...(opts.extraEnv ?? {}),
    ...buildManagedConnectionAliases(opts.providerKeys),
    ...(opts.runId ? { ROOMY_SANDBOX_TOKEN_PATH: sandboxTokenPath(opts.runId) } : {}),
    ...(opts.apiUrl ? { ROOMY_API_URL: opts.apiUrl } : {}),
  };
}

/** Legacy alias kept so existing callers can import without rename churn. */
export const buildDaemonEnv = buildPiEnv;
