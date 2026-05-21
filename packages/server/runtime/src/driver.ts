/**
 * Sandbox driver — talks to `opencode serve` over HTTP/SSE.
 *
 * One sandbox container per workspace; one `opencode serve` daemon per
 * container (lifecycle in `opencodeServer.ts`); one opencode session per
 * Desk chat (id persisted in the `chats` table, threaded in via
 * `RunOptions.opencodeSessionId`). Turns are appended to the same session
 * so context is retained across the lifetime of a chat.
 *
 * Event flow:
 *   1. `execRun` ensures the server is up and a session exists for the
 *      chat (creating it on first turn).
 *   2. Subscribes to the multiplexed SSE stream filtered to this session.
 *   3. POSTs the message; opencode runs the turn and streams events.
 *   4. Each `message.part.updated` SSE event is translated into the
 *      run-format JSON shape consumed by `scheduler/runs.ts` and the UI
 *      (see `opencodeEvents.ts`), then surfaced via `onLog`.
 *   5. The POST resolves when the assistant turn completes; cleanup
 *      unsubscribes from SSE.
 *
 * What's deliberately gone: per-turn `opencode run` cold-spawn, the
 * `setsid` wrapper, per-run pidfiles, process-group cleanup, the
 * pre-fire stale-tree sweep. Cancellation is now a single
 * `POST /session/:id/abort`. Crash recovery: an HTTP failure that looks
 * like ECONNREFUSED invalidates the cached server URL and fails the run
 * with a clear stderr — the user can resend and the next call re-spawns
 * the daemon.
 */

import { SANDBOX_HOME, type MountPlan } from "./mounts.js";
import { managedConnectionDefinitions } from "@agent-desk/shared";
import { connectionEnvNames } from "./docker.js";
import { LOCAL_SOURCE_ENV_NAMES } from "./localSources/index.js";
import { readAgentsModelDigest } from "./agentFile.js";
import { OpencodeClient, OpencodeServerError, isServerGoneError } from "./opencodeClient.js";
import { translateOpencodeSseEvent } from "./opencodeEvents.js";
import {
  ensureOpencodeServer,
  invalidateOpencodeServerCache,
  readDaemonLogTail,
  type OpencodeServerInstance,
} from "./opencodeServer.js";
import { withModule } from "@agent-desk/shared/logger";
import {
  synthesizeNonTextEvents,
  type PartEmissionState,
} from "./eventSynthesis.js";

export { synthesizeNonTextEvents, type PartEmissionState } from "./eventSynthesis.js";

const log = withModule("runtime/driver");

export interface RunOptions {
  runId: string;
  prompt: string;
  agentFileId?: string;
  /**
   * Workspace-relative paths the user attached to this message. The
   * driver reads each file from the host workspace and folds the content
   * into the message as additional text parts, so the model sees the
   * actual content without needing a tool call.
   */
  attachments?: string[];
  /** On-disk slug for the workspace this run belongs to. */
  workspaceSlug: string;
  /** Chat this run belongs to. Threaded through to the in-sandbox `desk` CLI for cross-chat safety. */
  chatId?: string;
  /** DESK_HOME root. When omitted, runtime storage resolution is used. */
  home?: string;
  mountPlan?: MountPlan;
  /**
   * Existing opencode-serve session id for the chat. Pass null/undefined
   * on the chat's first turn under the new runtime — the driver creates a
   * session and returns its id in `ExecResult.opencodeSessionId` for the
   * caller to persist.
   */
  opencodeSessionId?: string | null;
  /**
   * Called once per stdout/stderr/event log line. May be sync or async —
   * the driver tracks any returned promise and awaits all of them before
   * resolving `execRun`.
   */
  onLog: (event: LogEvent) => void | Promise<void>;
  /**
   * Model id, e.g. "opencode/big-pickle". The driver splits this on the
   * first slash into provider/model for the opencode API. When omitted,
   * opencode picks its default.
   */
  model?: string;
  /**
   * Ordered fallback chain. The driver tries `modelChain[0]` first; if
   * the daemon surfaces a retryable upstream error (rate-limit, 401, 5xx,
   * quota — see `isRetryableUpstreamError`), it emits a stderr notice
   * and resubmits the turn against `modelChain[i+1]` under the same
   * `sessionId`. The failed attempt's assistant message stays in the
   * session history. When omitted or empty, the driver falls back to
   * `[model ?? "opencode/big-pickle"]` (single-attempt behavior).
   */
  modelChain?: string[];
  /**
   * Provider API keys forwarded into the daemon at start time. When the
   * keys change, the daemon is restarted with the new env on the next
   * `execRun`.
   */
  providerKeys?: Record<string, string>;
  /** Non-key env vars forwarded into the daemon (currently the Codex/ChatGPT bridge content). */
  extraEnv?: Record<string, string>;
  /**
   * Per-run sandbox session token. Injected into the daemon's env at
   * start. The in-sandbox `desk` CLI reads it to authenticate back to the
   * REST API.
   */
  sandboxToken?: string;
  /** URL the in-sandbox `desk` CLI POSTs to. */
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
   * onto the chat row so subsequent turns reuse the same session.
   * Always populated when the run reached the message-dispatch step;
   * may be undefined if the run failed before the session was created
   * (e.g. server start-up failure).
   */
  opencodeSessionId?: string;
}

export interface SandboxDriver {
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
        ...(process.env.DESK_FAKE_DRIVER_LOG_PROVIDER_KEYS === "1"
          ? [`Provider keys: ${Object.keys(opts.providerKeys ?? {}).sort().join(",") || "none"}`]
          : []),
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

      return {
        exitCode: 0,
        opencodeSessionId: opts.opencodeSessionId ?? `fake_session_${runId}`,
      };
    },

    async cancelRun(runId) {
      cancelled.add(runId);
    },
  };
}

/**
 * Maps a workspace-relative attachment path to the matching sandbox path.
 * The whole workspace is bind-mounted at SANDBOX_HOME, so the rule is just
 * to prepend the home and strip any leading slash.
 */
export function toSandboxPath(rel: string): string {
  return `${SANDBOX_HOME}/${rel.replace(/^\/+/, "")}`;
}

/**
 * Splits a model string like "opencode/big-pickle" into `{providerID, modelID}`.
 * Falls back to provider "opencode" when the input has no slash.
 *
 * `codex/<name>` is a Desk-only UI relabel for OpenAI models authed via
 * the ChatGPT/Codex bridge (see `relabelOpenAiBySource`). The actual
 * model registry inside `opencode-serve` only knows the `openai`
 * provider, and the auth blob lands under `/auth/openai`. Translate
 * here so an agent saved with `model: "codex/gpt-5.5"` still resolves
 * against the registered `openai` provider on the daemon.
 */
export function parseModelSpec(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) return { providerID: "opencode", modelID: model };
  const provider = model.slice(0, slash);
  return {
    providerID: provider === "codex" ? "openai" : provider,
    modelID: model.slice(slash + 1),
  };
}

/**
 * Builds the `parts` array for `POST /session/:id/message`. Today this is
 * a single text part with the prompt, plus one text part per attachment
 * carrying its absolute (sandbox-side) path as a header. We deliberately
 * don't use opencode's file-part shape — version drift between minor
 * opencode releases has changed the field names there, and text parts are
 * universally supported.
 */
export function buildMessageParts(opts: {
  prompt: string;
  attachments?: string[];
}): unknown[] {
  const parts: unknown[] = [{ type: "text", text: opts.prompt }];
  for (const rel of opts.attachments ?? []) {
    const absPath = toSandboxPath(rel);
    parts.push({
      type: "text",
      text: `Attachment: ${absPath}\nRead this file from the workspace before answering.`,
    });
  }
  return parts;
}

/**
 * Tracks runs in flight so `cancelRun` can find the session to abort and
 * unsubscribe from SSE.
 */
interface ActiveRun {
  containerId: string;
  sessionId: string;
  client: OpencodeClient;
  unsubscribeSse: () => void;
  abortRequested: boolean;
}
const activeRuns = new Map<string, ActiveRun>();

/** Test-only: drops in-flight tracking without touching daemons. */
export function _resetActiveRunsForTest(): void {
  for (const entry of activeRuns.values()) entry.unsubscribeSse();
  activeRuns.clear();
}

/**
 * Returns true if any run is currently in flight on the given container.
 * Used by the connection-refresh path to skip workspaces with an active
 * run — restarting the daemon mid-turn would kill the in-flight model
 * call. Those workspaces still pick up the new env on the next message
 * via the env-digest restart in `ensureOpencodeServer`.
 */
export function hasActiveRunForContainer(containerId: string): boolean {
  for (const entry of activeRuns.values()) {
    if (entry.containerId === containerId) return true;
  }
  return false;
}

/**
 * Polling-as-truth (driver-internal contract):
 *
 * The driver polls `GET /session/:id/message` on a fixed cadence both to
 * synthesize tool/reasoning/step events (opencode-serve doesn't broadcast
 * them over SSE) AND to detect turn-terminal state authoritatively. The
 * polled state is the source of truth for "this turn is done"; the in-
 * flight `POST /session/:id/message` is a convenience that *may* resolve
 * first on the happy path but is not required to.
 *
 * Why: a wedged-but-not-crashed daemon (cgroup OOM, deadlocked event
 * loop, transport-level stall behind docker-proxy holding the host
 * socket) leaves the HTTP POST hanging with no observable error. SSE
 * silently stops emitting. Without an independent liveness signal, the
 * run hangs to the per-message budget with zero user feedback — the
 * worst observed chaos-test failure mode (see CHAOS_TESTING.md).
 *
 * Each poll request gets `POLL_HTTP_TIMEOUT_MS` to return. After
 * `POLL_FAILURE_THRESHOLD` consecutive failures the loop raises
 * `PollLivenessFailure` — treated by the catch block as daemon-gone,
 * routed into the same silent-retry recovery used for ECONNREFUSED.
 *
 * `POLL_INTERVAL_MS × POLL_FAILURE_THRESHOLD + POLL_HTTP_TIMEOUT_MS`
 * gives the worst-case detection budget — currently ~6.5s.
 */
const POLL_INTERVAL_MS = 500;
const POLL_HTTP_TIMEOUT_MS = 3000;
const POLL_FAILURE_THRESHOLD = 3;

/**
 * Raised by the run loop's polling task when consecutive HTTP failures
 * against `GET /session/:id/message` cross `POLL_FAILURE_THRESHOLD`.
 *
 * Treated identically to a sendMessage-thrown daemon-gone error by the
 * catch block — the existing recovery (invalidate cache, re-acquire
 * via `acquireDaemonWithRecovery`, silent retry) handles it. The class
 * exists so the catch block can distinguish "polling lost the daemon"
 * from a sendMessage-side ECONNREFUSED, which is useful for the
 * structured log line but not for the control flow.
 */
class PollLivenessFailure extends Error {
  readonly cause: Error;
  readonly consecutiveFailures: number;

  constructor(cause: Error, consecutiveFailures: number) {
    super(
      `opencode-serve liveness polling failed ${consecutiveFailures}× consecutively: ` +
        `${cause.message ?? String(cause)}`,
    );
    this.name = "PollLivenessFailure";
    this.cause = cause;
    this.consecutiveFailures = consecutiveFailures;
  }
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

      // `createOrReuse` already has its own internal retry/self-heal
      // loop (drift recreate, port-bind race, container-gone-mid-poll
      // — see CREATE_OR_REUSE_MAX_ATTEMPTS in docker.ts). The thin
      // catch here only covers the residual case where the container
      // is removed in the millisecond gap between `createOrReuse`
      // returning and the next operation taking a reference. A single
      // retry is enough; a persistent failure bubbles up.
      let handle: Awaited<ReturnType<typeof acquireHandle>>;
      try {
        handle = await acquireHandle();
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (!isContainerGoneError(msg)) throw err;
        handle = await acquireHandle();
      }

      const user = await sandboxUser(engine);

      // Provider keys + managed-connection env live in the daemon's
      // process env. A change in any of these (e.g. a refreshed
      // OPENCODE_API_KEY) restarts the daemon — `ensureOpencodeServer`
      // diffs the env digest and rebuilds on mismatch.
      //
      // Per-run vars (the sandbox token, the API URL) reach in-sandbox
      // tools via a stable indirection rather than directly in the
      // daemon's env: the daemon's env has `DESK_SANDBOX_TOKEN_PATH`
      // pointing at a fixed file we rewrite per turn. The in-sandbox
      // `desk-agent` CLI reads the file each time it runs. This way the
      // env-digest stays the same across runs (no spurious daemon
      // restarts under concurrent load) while per-run token rotation is
      // preserved.
      //
      // Also: hash every agent file's `model:` line and feed it into
      // the env. The daemon caches each agent's resolved model at
      // startup (the daemon is single-threaded init + long-lived
      // listener — there is no agent-file watcher) and ignores per-
      // message `providerID`/`modelID` overrides for agent-bound
      // sessions. So rewriting the agent file mid-life is invisible
      // until the daemon restarts. Including the model-line digest
      // here lets ensureOpencodeServer's env-digest compare detect
      // *content* changes that should kick a restart — covers the
      // fallback path that rewrites `codex/X` → `opencode/big-pickle`
      // when auth is missing, and any future "agent's model changed
      // out of band" path.
      const agentFilesDigest = opts.home
        ? await readAgentsModelDigest(opts.home, opts.workspaceSlug).catch(() => "")
        : "";
      const daemonEnv = buildDaemonEnv({
        providerKeys: opts.providerKeys,
        extraEnv: opts.extraEnv,
        apiUrl: opts.apiUrl,
        agentFilesDigest,
      });

      // Daemon acquisition is the noisiest failure surface in the
      // runtime — cgroup OOMs the daemon dead, RootlessKit fails to
      // wire 9105 even though the container is "running", waitForReady
      // times out under host load, the scheduler reaps a sibling
      // container mid-spawn, etc. Each of these is recoverable by some
      // combination of "grow the cgroup", "kill + restart the daemon"
      // and "recreate the container". `acquireDaemonWithRecovery`
      // owns the retry topology so the user-visible path here is just
      // "we got a daemon" or "we exhausted every recovery — surface
      // a single clean error". No intermediate failure reaches `onLog`.
      let server: OpencodeServerInstance;
      try {
        const acquired = await acquireDaemonWithRecovery({
          engine,
          workspaceId,
          user,
          daemonEnv,
          initialHandle: handle,
          acquireHandle,
        });
        handle = acquired.handle;
        server = acquired.server;
      } catch (err) {
        // Every recovery path exhausted. Surface the LAST recovery
        // attempt's error so the user sees a coherent message instead
        // of the cascade we just dampened. The structured `recovery`
        // metadata goes to server-side logs only.
        const finalErr = err as DaemonAcquireFailure;
        const tail = await readDaemonLogTail(engine, handle.containerId).catch(() => "");
        log.error(
          {
            workspaceId,
            attempts: finalErr.attempts,
            recoveryEvents: finalErr.recoveryEvents,
            finalKind: finalErr.kind,
            finalMessage: finalErr.cause?.message ?? String(finalErr.cause),
          },
          "sandbox: exhausted daemon-acquire retries; surfacing failure to user",
        );
        await opts.onLog({
          runId: opts.runId,
          seq: 0,
          kind: "stderr",
          payload: `opencode-serve failed to start after ${finalErr.attempts} attempts: ${
            finalErr.cause?.message ?? String(finalErr.cause)
          }${tail ? `\nopencode-serve.log tail:\n${tail}` : ""}${
            finalErr.kind === "oom"
              ? formatStartupOomMarker(finalErr.lastOomKillCount)
              : ""
          }`,
        });
        return { exitCode: 1 };
      }

      let client = new OpencodeClient(server.url, server.password);

      const writeSandboxToken = async () => {
        // Write the per-run sandbox token to the daemon's container at
        // the stable path the in-sandbox CLI reads. Writing per-run keeps
        // the daemon's env digest stable across runs (no restart per
        // turn) while still rotating identity per chat-turn. Skipped when
        // no token was minted (older callers).
        if (!opts.sandboxToken) return;
        await writeSandboxTokenFile(engine, handle.containerId, user, opts.sandboxToken).catch(
          (err) => {
            log.warn(
              { runId: opts.runId, err: (err as Error)?.message ?? String(err) },
              "runtime: failed to write sandbox token file",
            );
          },
        );
      };
      await writeSandboxToken();

      // Same recovery window as the `ensureOpencodeServer` block above:
      // between caching the daemon URL and the first POST, the daemon
      // can die (idle-daemon sweeper, OOM-kill, container reaper that
      // raced with this fire). The cached server instance points at a
      // dead port; the next `fetch` here surfaces as a bare
      // `TypeError: fetch failed` (ECONNREFUSED / socket closed). Catch
      // server-gone failures, invalidate the cache, re-acquire the
      // container, and retry the session resolve once before bubbling
      // up so the scheduler logs a clean error.
      let sessionResolution: { sessionId: string; recreated: boolean };
      try {
        sessionResolution = await resolveSessionId(client, opts.opencodeSessionId ?? null);
      } catch (err) {
        if (!isServerGoneError(err)) throw err;
        invalidateOpencodeServerCache(handle.containerId, server);
        handle = await acquireHandle();
        try {
          server = await ensureOpencodeServer(engine, {
            containerId: handle.containerId,
            cwd: SANDBOX_HOME,
            user,
            env: daemonEnv,
          });
        } catch (retryErr) {
          await opts.onLog({
            runId: opts.runId,
            seq: 0,
            kind: "stderr",
            payload:
              `opencode-serve was unreachable and re-spawn failed: ${(retryErr as Error).message ?? String(retryErr)}`,
          });
          return { exitCode: 1 };
        }
        client = new OpencodeClient(server.url, server.password);
        await writeSandboxToken();
        sessionResolution = await resolveSessionId(client, opts.opencodeSessionId ?? null);
      }
      const sessionId = sessionResolution.sessionId;
      if (sessionResolution.recreated && opts.opencodeSessionId) {
        // Surface a stderr line so the chat shows the user that prior
        // context was lost. The next turn starts fresh on the new
        // session; the scheduler will persist the new id on the chat
        // row when this run returns.
        await opts.onLog({
          runId: opts.runId,
          seq: 0,
          kind: "stderr",
          payload:
            `opencode session ${opts.opencodeSessionId} is no longer reachable; ` +
            `starting a fresh session (${sessionId}). Prior conversation history is not carried over.`,
        });
      }

      // Shared across all message-send attempts. `seq` accumulates so
      // we can detect "no events emitted yet" as the safe-to-silently-
      // retry condition; `pendingLogs` carries onLog promises through
      // the whole run.
      let seq = 0;
      const pendingLogs: Promise<unknown>[] = [];
      const emitLog = (kind: LogEvent["kind"], payload: string) => {
        const ret = opts.onLog({ runId: opts.runId, seq: seq++, kind, payload });
        if (ret && typeof (ret as Promise<unknown>).then === "function") {
          pendingLogs.push((ret as Promise<unknown>).catch(() => {}));
        }
      };

      // Ordered model fallback chain. The driver tries `chain[0]` first;
      // on a retryable upstream error (rate-limit / 401 / 5xx / quota —
      // see `isRetryableUpstreamError`), it emits a stderr notice and
      // resubmits the turn against the next entry under the same
      // `sessionId`. The failed attempt's assistant message stays in
      // opencode's session history. Single-entry chains are the
      // legacy "single model, no fallback" behavior.
      const chain = opts.modelChain && opts.modelChain.length > 0
        ? opts.modelChain
        : [opts.model ?? "opencode/big-pickle"];
      const parts = buildMessageParts({
        prompt: opts.prompt,
        attachments: opts.attachments,
      });

      // Mid-message recovery loop. If the daemon dies before any
      // events reach the user (the common case: cgroup OOM during
      // model init, before the first text delta), we silently
      // recover (grow + re-spawn via `acquireDaemonWithRecovery`) and
      // re-POST the message. Once any user-visible event has been
      // emitted (`seq > 0`), the user's chat has already shown
      // partial output — a silent retry would produce a confusing
      // duplicate. In that case we fall through to the existing
      // error-emit path so the scheduler's outer retry + log truncate
      // handles the recovery (with partial-output flicker, which is
      // the WS-protocol gap noted in the design).
      let unsubscribe: (() => void) = () => {};
      let tracked: ActiveRun | undefined;
      let pollingDone = false;
      let pollTask: Promise<void> = Promise.resolve();
      let cleanupDone = false;
      const teardownAttempt = async () => {
        pollingDone = true;
        await pollTask.catch(() => {});
        pollTask = Promise.resolve();
        pollingDone = false;
        unsubscribe();
        unsubscribe = () => {};
        if (tracked) {
          activeRuns.delete(opts.runId);
          tracked = undefined;
        }
      };
      const teardownFinal = async () => {
        if (cleanupDone) return;
        cleanupDone = true;
        await teardownAttempt();
      };

      const MESSAGE_SEND_MAX_ATTEMPTS = 3;
      // Two retry axes share the same attempt loop:
      //   - `messageAttempt` (bounded by MESSAGE_SEND_MAX_ATTEMPTS):
      //     consumed by every iteration. Drives silent transport
      //     recovery on daemon-gone failures.
      //   - `chainIdx`: advances when polling surfaces a retryable
      //     upstream model error from `chain[chainIdx]`. The next
      //     iteration runs against the next model in the chain under
      //     the same opencode session. The failed attempt's assistant
      //     message stays in opencode's session history.
      // Both axes consume the same MESSAGE_SEND_MAX_ATTEMPTS budget on
      // purpose: a noisy combination of transport + upstream failures
      // shouldn't exceed three sandbox-side sendMessage round-trips.
      let chainIdx = 0;
      try {
        for (let messageAttempt = 0; messageAttempt < MESSAGE_SEND_MAX_ATTEMPTS; messageAttempt++) {
          const modelSpec = chain[chainIdx];
          const { providerID, modelID } = parseModelSpec(modelSpec);
          // Wire SSE subscription before sending the message so we
          // don't miss early events. The multiplexer dedups its own
          // connection. Each retry needs a fresh subscription against
          // the (possibly new) daemon URL captured in `client`.
          unsubscribe = client.subscribeSessionEvents(sessionId, (sseEvent) => {
            const line = translateOpencodeSseEvent(sseEvent, { sessionID: sessionId });
            if (line !== null) emitLog("event", line);
          });

          // Wait until the SSE stream has acknowledged our subscription
          // before dispatching the message — otherwise the per-message
          // events emitted in the first ~ms can race past a still-
          // handshaking SSE socket and never reach `onLog`. A timeout
          // here (60s default, set in opencodeClient) fires only when
          // the daemon is wedged at handshake; that's a daemon-gone
          // signal as far as recovery is concerned, so let the catch
          // below treat it identically — the silent retry will tear
          // down + re-spawn + re-subscribe.
          try {
            await client.sseReady();
          } catch (err) {
            const haveRetries = messageAttempt < MESSAGE_SEND_MAX_ATTEMPTS - 1;
            if (isServerGoneError(err) && haveRetries) {
              log.warn(
                {
                  workspaceId,
                  runId: opts.runId,
                  containerId: handle.containerId,
                  attempt: messageAttempt,
                  message: (err as Error).message ?? String(err),
                },
                "sandbox: SSE handshake failed (wedged daemon); recovering invisibly",
              );
              await teardownAttempt();
              // CAS-protected: if a sibling chat's recovery already
              // populated a fresh daemon, leave it alone (the next
              // acquireDaemonWithRecovery call will see it via cache
              // and return it without spawning).
              invalidateOpencodeServerCache(handle.containerId, server);
              try {
                const acquired = await acquireDaemonWithRecovery({
                  engine,
                  workspaceId,
                  user,
                  daemonEnv,
                  initialHandle: handle,
                  acquireHandle,
                });
                handle = acquired.handle;
                server = acquired.server;
                client = new OpencodeClient(server.url, server.password);
                await writeSandboxToken();
                continue;
              } catch (recoveryErr) {
                const finalErr = recoveryErr as DaemonAcquireFailure;
                emitLog(
                  "stderr",
                  `opencode-serve SSE handshake wedged and recovery exhausted after ${finalErr.attempts} attempts: ` +
                    `${finalErr.cause?.message ?? String(finalErr.cause)}`,
                );
                await Promise.all(pendingLogs);
                return { exitCode: 1, opencodeSessionId: sessionId };
              }
            }
            emitLog(
              "stderr",
              `opencode-serve event stream failed to open: ${(err as Error).message ?? String(err)}`,
            );
            return { exitCode: 1, opencodeSessionId: sessionId };
          }

          tracked = {
            containerId: handle.containerId,
            sessionId,
            client,
            unsubscribeSse: unsubscribe,
            abortRequested: false,
          };
          activeRuns.set(opts.runId, tracked);

          // opencode-serve 1.14.50 only broadcasts text/reasoning
          // deltas over SSE. Tool calls, step-start, step-finish
          // parts are written to its SQLite during the turn and only
          // readable via `GET /session/:id/message`. To make tool
          // cards appear as they happen rather than only after
          // sendMessage returns, we poll listSessionMessages every
          // ~500ms during the turn and emit any non-text part not
          // yet seen. The same `partState` set is reused by the
          // post-turn backstop loop so nothing double-emits.
          const partState: PartEmissionState = new Map();
          // Snapshot existing assistant-message IDs so the polling
          // loop ignores prior turns that share this session. Cap
          // the call at 3s — when the daemon is unresponsive (just
          // spawned, mid-restart), an unbounded await here parks
          // the entire run before sendMessage ever fires.
          const baselineMessageIds = new Set<string>();
          try {
            const messages = await Promise.race([
              client.listSessionMessages(sessionId),
              new Promise<unknown[]>((_, rej) =>
                setTimeout(() => rej(new Error("baseline-timeout")), 3000),
              ),
            ]);
            for (const m of messages) {
              const info = (m as { info?: { id?: unknown; role?: unknown } }).info;
              const id = info && (info as { id?: unknown }).id;
              if (typeof id === "string") baselineMessageIds.add(id);
            }
          } catch {
            // best-effort
          }

          pollingDone = false;
          // Capture `client` in a stable local so the polling loop
          // talks to the daemon URL valid for this attempt; on a
          // silent retry the outer `client` is reassigned but this
          // attempt's pollTask is torn down first.
          const pollClient = client;

          // Polling-as-truth: this loop both emits synth events AND
          // signals the run-completion outcome. `pollOutcome` resolves
          // when the assistant turn reaches terminal state (or the
          // daemon surfaces an upstream model error in `info.error`),
          // rejects when consecutive HTTP failures cross
          // POLL_FAILURE_THRESHOLD. The send-message block races this
          // promise against the in-flight `sendMessage` call.
          type PollOutcome =
            | {
                kind: "terminal";
                finalAssistantId: string;
                userMessageId: string;
              }
            | { kind: "upstream-error"; message: string };
          let pollOutcomeResolve: (v: PollOutcome) => void = () => {};
          let pollOutcomeReject: (err: Error) => void = () => {};
          const pollOutcome = new Promise<PollOutcome>((res, rej) => {
            pollOutcomeResolve = res;
            pollOutcomeReject = rej;
          });
          // Suppress unhandled-rejection if the catch block decides
          // it doesn't need to inspect the rejection (e.g. sendMessage
          // resolved first on the happy path).
          pollOutcome.catch(() => {});

          let consecutivePollFailures = 0;
          pollTask = (async () => {
            while (!pollingDone) {
              await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
              if (pollingDone) break;
              try {
                const messages = await pollClient.listSessionMessages(
                  sessionId,
                  AbortSignal.timeout(POLL_HTTP_TIMEOUT_MS),
                );
                consecutivePollFailures = 0;

                // Walk new (non-baseline) assistant messages: emit
                // synthesized events for every one, and track the
                // latest as the candidate for terminal detection.
                let latestAssistant:
                  | { info: { id: string; parentID?: string; error?: unknown }; parts?: unknown[] }
                  | null = null;
                for (const m of messages) {
                  if (!m || typeof m !== "object") continue;
                  const info = (m as { info?: { id?: unknown; role?: unknown; parentID?: unknown; error?: unknown } }).info;
                  if (!info || typeof info !== "object") continue;
                  const id = (info as { id?: unknown }).id;
                  const role = (info as { role?: unknown }).role;
                  if (typeof id !== "string" || baselineMessageIds.has(id)) continue;
                  if (role !== "assistant") continue;
                  for (const line of synthesizeNonTextEvents(m, sessionId, partState)) {
                    emitLog("event", line);
                  }
                  const parentID = (info as { parentID?: unknown }).parentID;
                  latestAssistant = {
                    info: {
                      id,
                      parentID: typeof parentID === "string" ? parentID : undefined,
                      error: (info as { error?: unknown }).error,
                    },
                    parts: (m as { parts?: unknown[] }).parts,
                  };
                }

                if (latestAssistant) {
                  // opencode-serve encodes upstream model failures
                  // (rate limit, deprecated model, provider 401) as
                  // `info.error` on the assistant message. Treat as a
                  // user-visible terminal error — same shape as the
                  // legacy sendMessage-response path used to.
                  const upstreamError = describeDaemonError(latestAssistant.info.error);
                  if (upstreamError) {
                    pollOutcomeResolve({ kind: "upstream-error", message: upstreamError });
                    return;
                  }
                  // Terminal completion: the final part is `step-finish`
                  // with a terminal reason. opencode-serve commits this
                  // to its SQLite atomically with the rest of the turn,
                  // so once it's visible the turn is fully durable.
                  if (
                    isAssistantTurnComplete(latestAssistant) &&
                    latestAssistant.info.parentID
                  ) {
                    pollOutcomeResolve({
                      kind: "terminal",
                      finalAssistantId: latestAssistant.info.id,
                      userMessageId: latestAssistant.info.parentID,
                    });
                    return;
                  }
                }
              } catch (err) {
                // AbortError (per-call timeout) or HTTP/network error.
                // Bounded retry: a brief daemon hiccup mustn't kill an
                // otherwise-healthy run. After POLL_FAILURE_THRESHOLD
                // consecutive failures, declare daemon-gone and route
                // into the catch block's silent-retry recovery.
                consecutivePollFailures++;
                if (consecutivePollFailures >= POLL_FAILURE_THRESHOLD) {
                  pollOutcomeReject(
                    new PollLivenessFailure(err as Error, consecutivePollFailures),
                  );
                  return;
                }
              }
            }
          })();

          // Snapshot `seq` BEFORE sendMessage so we can tell whether
          // any user-visible events were emitted during this attempt.
          // Silent retry only safe when nothing has reached the user.
          const seqAtAttemptStart = seq;
          // AbortController for the in-flight sendMessage POST. We
          // fire-and-forget the request; the polling loop above is
          // authoritative for "turn done." The POST is just a write
          // (kicks off the turn server-side) — its HTTP resolution
          // tells us nothing reliable because a dying daemon's
          // docker-proxy can return a stub-200 with an empty body
          // before the daemon's actually processed anything. The
          // signal lets us tear it down cleanly when polling has
          // returned its verdict.
          const sendAbort = new AbortController();
          try {
            // Kickoff sendMessage. We never await its resolution as
            // proof of completion. Its rejection (UND_ERR_SOCKET,
            // ECONNRESET, etc.) IS meaningful — that's a daemon-gone
            // signal the catch block routes into recovery.
            const sendPromise = client.sendMessage(
              sessionId,
              {
                providerID,
                modelID,
                parts,
                ...(opts.agentFileId ? { agent: opts.agentFileId } : {}),
              },
              sendAbort.signal,
            );
            // Translate sendMessage rejection into a thenable that
            // ONLY rejects, never resolves — so the race below can
            // route a daemon-gone signal into the same catch path as
            // a polling-detected liveness failure, while sendMessage
            // *resolving* is treated as a no-op (we don't trust the
            // response body — see the kickoff comment above).
            const sendRejection = new Promise<never>((_, rej) => {
              sendPromise.then(
                () => {
                  // Resolved with a body we don't trust. Do nothing —
                  // polling will provide the authoritative outcome.
                },
                (err) => rej(err),
              );
            });
            sendRejection.catch(() => {});

            // Race polling-detected outcome against sendMessage's
            // rejection. The poll loop will either resolve with terminal
            // state (the assistant turn reached `step-finish` durably on
            // disk) or with an upstream model error captured on the
            // assistant message; or reject with PollLivenessFailure
            // after consecutive HTTP failures crossed the threshold.
            // sendMessage's rejection (if it ever happens) is treated
            // as another daemon-gone signal, same recovery routing.
            const outcome = await Promise.race([pollOutcome, sendRejection]);
            // Polling won the race with a useful verdict. Tear down
            // sendMessage's in-flight POST (which may still be holding
            // a socket open) before we proceed.
            sendAbort.abort();

            if (outcome.kind === "upstream-error") {
              // Model-chain fallback: when the failed model isn't the
              // last in the chain and the error matches the retryable
              // pattern (rate-limit / 401 / 5xx / quota / model-not-
              // found — see `isRetryableUpstreamError`), advance
              // `chainIdx` and let the loop re-issue sendMessage
              // against the next model under the same session. Same
              // attempt-budget — a model fallback consumes one of the
              // MESSAGE_SEND_MAX_ATTEMPTS slots.
              const isLastInChain = chainIdx === chain.length - 1;
              const haveRetries = messageAttempt < MESSAGE_SEND_MAX_ATTEMPTS - 1;
              if (!isLastInChain && haveRetries && isRetryableUpstreamError(outcome.message)) {
                const next = chain[chainIdx + 1];
                emitLog(
                  "stderr",
                  `Model ${modelSpec} hit upstream error (${outcome.message}); falling back to ${next}.`,
                );
                await teardownAttempt();
                chainIdx++;
                continue;
              }
              emitLog(
                "stderr",
                `opencode-serve model error (${modelID}): ${outcome.message}`,
              );
              const tail = await readDaemonLogTail(engine, handle.containerId).catch(() => "");
              if (tail) emitLog("stderr", `opencode-serve.log tail:\n${tail}`);
              await Promise.all(pendingLogs);
              return { exitCode: 1, opencodeSessionId: sessionId };
            }

            // Terminal seen via polling. Final synchronous pass to
            // capture parts the daemon committed in the last poll
            // interval. `partState` keeps it from re-emitting anything
            // the live loop already surfaced.
            const { finalAssistantId, userMessageId } = outcome;
            try {
              for (const msg of await collectTurnAssistantMessages(
                client,
                sessionId,
                userMessageId,
                finalAssistantId,
              )) {
                for (const line of synthesizeNonTextEvents(msg, sessionId, partState)) {
                  emitLog("event", line);
                }
              }
            } catch (err) {
              log.warn(
                { runId: opts.runId, err: (err as Error)?.message ?? String(err) },
                "runtime: listSessionMessages failed (post-poll backstop)",
              );
            }
            if (messageAttempt > 0) {
              log.info(
                { workspaceId, runId: opts.runId, attempts: messageAttempt + 1 },
                "sandbox: recovered mid-message daemon crash invisibly",
              );
            }
            await Promise.all(pendingLogs);
            return {
              exitCode: tracked.abortRequested ? 130 : 0,
              opencodeSessionId: sessionId,
            };
          } catch (err) {
            // Make sure no hanging fetch survives past return.
            sendAbort.abort();
            if (tracked.abortRequested) {
              // The abort path already surfaced a log line. Treat the
              // resulting HTTP error as expected.
              await Promise.all(pendingLogs);
              return { exitCode: 130, opencodeSessionId: sessionId };
            }

            // Silent-retry preconditions: nothing reached the user
            // during this attempt, the failure looks like daemon-gone,
            // and we have retries left. If any of these is false, fall
            // through to the user-visible error path (existing logic).
            //
            // `PollLivenessFailure` is the polling-as-truth layer's
            // way of saying "the daemon stopped answering"; route it
            // through the same silent-retry as a sendMessage-raised
            // ECONNREFUSED/etc. The distinction is preserved in the
            // log line below so triage knows which detector fired.
            const noEventsThisAttempt = seq === seqAtAttemptStart;
            const isPollFailure = err instanceof PollLivenessFailure;
            const isDaemonGone = isPollFailure || isServerGoneError(err);
            const haveRetries = messageAttempt < MESSAGE_SEND_MAX_ATTEMPTS - 1;
            if (noEventsThisAttempt && isDaemonGone && haveRetries) {
              const message = (err as Error).message ?? String(err);
              log.warn(
                {
                  workspaceId,
                  runId: opts.runId,
                  containerId: handle.containerId,
                  attempt: messageAttempt,
                  detector: isPollFailure ? "poll-liveness" : "send-error",
                  message,
                },
                "sandbox: daemon died before emitting any event; recovering and retrying invisibly",
              );
              await teardownAttempt();
              // CAS: only invalidate if our (now-dead) instance is
              // still the cached one. Concurrent sibling chats sharing
              // this daemon all detect the same death and reach this
              // block at once — without the CAS guard, each one wipes
              // the previous one's fresh respawn, locking the workspace
              // in a spawn-kill-spawn loop (see chaos-test report).
              invalidateOpencodeServerCache(handle.containerId, server);
              try {
                const acquired = await acquireDaemonWithRecovery({
                  engine,
                  workspaceId,
                  user,
                  daemonEnv,
                  initialHandle: handle,
                  acquireHandle,
                });
                handle = acquired.handle;
                server = acquired.server;
                client = new OpencodeClient(server.url, server.password);
                await writeSandboxToken();
              } catch (recoveryErr) {
                // Recovery exhausted. Emit a single clean stderr (the
                // user sees one error, not the cascade we just
                // dampened) and bail.
                const finalErr = recoveryErr as DaemonAcquireFailure;
                log.error(
                  {
                    workspaceId,
                    runId: opts.runId,
                    midMessageAttempt: messageAttempt,
                    recoveryAttempts: finalErr.attempts,
                    finalKind: finalErr.kind,
                  },
                  "sandbox: mid-message daemon recovery exhausted; surfacing to user",
                );
                emitLog(
                  "stderr",
                  `opencode-serve crashed mid-message and failed to recover after ${finalErr.attempts} attempts: ` +
                    `${finalErr.cause?.message ?? String(finalErr.cause)}` +
                    (finalErr.kind === "oom"
                      ? formatStartupOomMarker(finalErr.lastOomKillCount)
                      : ""),
                );
                await Promise.all(pendingLogs);
                return { exitCode: 1, opencodeSessionId: sessionId };
              }
              // Loop continues — next iteration re-subscribes SSE and
              // re-POSTs the message against the fresh daemon.
              continue;
            }

            // User-visible failure path (same shape as before the
            // recovery loop existed — preserves the OOM marker so
            // the scheduler's outer retry can still classify).
            const message = (err as Error).message ?? String(err);
            emitLog("stderr", `opencode-serve message failed: ${message}`);
            const tail = await readDaemonLogTail(engine, handle.containerId).catch(() => "");
            if (tail) emitLog("stderr", `opencode-serve.log tail:\n${tail}`);
            if (isDaemonGone) {
              invalidateOpencodeServerCache(handle.containerId, server);
              const oomBytes = await readCgroupOomKillCount(engine, handle.containerId).catch(() => 0);
              if (oomBytes > 0) {
                emitLog(
                  "stderr",
                  `opencode-serve was OOM-killed by the cgroup (memory.events oom_kill=${oomBytes}); ` +
                    `flagging as ENOMEM so the sandbox grows on retry.`,
                );
              }
            } else if (err instanceof OpencodeServerError && err.status === 404) {
              await client.deleteSession(sessionId).catch(() => {});
              await Promise.all(pendingLogs);
              return { exitCode: 1 };
            }
            await Promise.all(pendingLogs);
            return { exitCode: 1, opencodeSessionId: sessionId };
          }
        }
        // Loop fell through (unreachable in practice: every iteration
        // either returns or continues). Defensive return.
        emitLog("stderr", `opencode-serve message send: retry budget exhausted without classification`);
        return { exitCode: 1, opencodeSessionId: sessionId };
      } finally {
        await teardownFinal();
      }
    },

    async cancelRun(runId) {
      const tracked = activeRuns.get(runId);
      if (!tracked) return;
      tracked.abortRequested = true;
      try {
        await tracked.client.abortSession(tracked.sessionId);
      } catch {
        // Best-effort: if the daemon's gone, the run is already over.
      }
    },
  };
}

// `PartEmissionState` / `synthesizeNonTextEvents` live in
// `./eventSynthesis.ts` to keep this file under the max-lines cap;
// re-exported from the top-of-file import block for back-compat.

/**
 * Pulls a one-line human-readable description out of opencode-serve's
 * `info.error` envelope. The daemon swallows upstream model failures
 * (zen rate limit, deprecated model, provider 401) and resolves the
 * `POST /session/:id/message` call cleanly with the error encoded in
 * the response body — so the runtime never gets an HTTP exception
 * even though no text was produced. Use this to detect that case and
 * report it to the user as a real failure instead of letting the run
 * fall through as "succeeded with no output."
 *
 * Returns null when there is no error — the caller treats null as
 * "happy path." Handles the common shapes opencode-serve emits:
 *
 *   { name: "APIError", data: { message: "...", responseBody: "..." } }
 *   { name, message }
 *   bare string
 */
/**
 * Classifies a daemon-side or transport error message as worth retrying
 * against the next model in `RunOptions.modelChain`. We re-attempt when
 * the upstream provider is transiently unavailable (rate-limit,
 * concurrency cap, 5xx) OR has rejected our credential (401/403, invalid
 * key) — both are "user's preferred model can't respond right now; fall
 * through to the chain's safety net" cases.
 *
 * Patterns kept broad on purpose: opencode-serve wraps each provider's
 * native error envelope in slightly different ways across releases, so
 * matching by message substring + canonical HTTP status survives version
 * drift better than parsing structured fields. Word-boundary HTTP
 * matchers guard against false positives on transcript text that
 * happens to contain digits (e.g. `42960 tokens`).
 *
 * Not retryable: validation errors, 400 (bad request — the chain won't
 * help), `ProviderConfigError` (wiring is wrong), generic transport
 * blow-ups handled elsewhere by `isServerGoneError`.
 */
export function isRetryableUpstreamError(errMessage: string | null | undefined): boolean {
  if (!errMessage) return false;
  const s = errMessage.toLowerCase();
  // HTTP status patterns — word-boundary to avoid `42960`-style false matches.
  if (/\b429\b/.test(s)) return true;
  if (/\b40[13]\b/.test(s)) return true;
  if (/\b5\d\d\b/.test(s)) return true;
  // Provider-message patterns.
  if (/rate.?limit/.test(s)) return true;
  if (/usage\s*limit/.test(s)) return true;
  if (/quota\s*exceeded/.test(s)) return true;
  if (/high\s*concurrency/.test(s)) return true;
  if (/unauthorized/.test(s)) return true;
  if (/invalid.*api.?key/.test(s)) return true;
  if (/providermodelnotfounderror/.test(s)) return true;
  return false;
}

export function describeDaemonError(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);
  const e = error as { name?: unknown; message?: unknown; data?: unknown };
  const data = (e.data && typeof e.data === "object" ? e.data : null) as
    | { message?: unknown; responseBody?: unknown; statusCode?: unknown }
    | null;
  // `data.message` is opencode's normalised "what went wrong" string —
  // prefer it when present because top-level `name` is usually a
  // generic class name (`APIError`, `ProviderModelNotFoundError`).
  const inner = data && typeof data.message === "string" ? data.message : null;
  const top = typeof e.message === "string" ? e.message : null;
  const name = typeof e.name === "string" ? e.name : null;
  const status = data && typeof data.statusCode === "number" ? ` (HTTP ${data.statusCode})` : "";
  if (inner) return `${name ? `${name}: ` : ""}${inner}${status}`;
  if (top) return `${name ? `${name}: ` : ""}${top}${status}`;
  if (name) return `${name}${status}`;
  // Last-resort serialization — never throw out of an error handler.
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// `extractAssistantInfoMeta` moved to `./eventSynthesis.ts`.

/**
 * Locate the assistant message we just generated in a `GET
 * /session/:id/message` response. The endpoint returns the full
 * conversation; we want the message whose `info.id` matches the id
 * the daemon returned from `sendMessage`.
 */
function findAssistantMessage(
  messages: unknown[],
  assistantId: string,
): { parts?: unknown[] } | null {
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const info = (m as { info?: { id?: unknown } }).info;
    if (info && typeof info === "object" && (info as { id?: unknown }).id === assistantId) {
      return m as { parts?: unknown[] };
    }
  }
  return null;
}

/**
 * Returns every assistant message produced for one turn, in chrono
 * order — the entire chain from the user message to the final
 * assistant message. Polls `listSessionMessages` briefly to absorb
 * the race where opencode commits parts to its SQLite *after*
 * `sendMessage` resolves; "complete" here means the final assistant
 * message's last part is a terminal step-finish (reason `stop` /
 * `length` / `content-filter` / `error`). If the budget is exhausted
 * we return the latest snapshot anyway so the user at least sees
 * what arrived.
 */
async function collectTurnAssistantMessages(
  client: OpencodeClient,
  sessionId: string,
  userMessageId: string,
  finalAssistantId: string,
): Promise<{ parts?: unknown[] }[]> {
  const deadline = Date.now() + 5000;
  const intervalMs = 200;
  let latest: { parts?: unknown[] }[] = [];
  while (true) {
    const messages = await client.listSessionMessages(sessionId);
    const turn = sliceAssistantTurn(messages, userMessageId);
    if (turn.length > 0) latest = turn;
    const finalInTurn = findAssistantMessage(turn, finalAssistantId);
    if (finalInTurn && isAssistantTurnComplete(finalInTurn)) return turn;
    if (Date.now() >= deadline) return latest;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Walks the session's full message list and returns every assistant
 * message that appeared after the given user message id. Preserves
 * the daemon's chronological ordering (it returns the list sorted
 * by creation time already).
 */
function sliceAssistantTurn(
  messages: unknown[],
  userMessageId: string,
): { parts?: unknown[] }[] {
  const out: { parts?: unknown[] }[] = [];
  let pastUser = false;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const info = (m as { info?: { id?: unknown; role?: unknown } }).info;
    if (!info || typeof info !== "object") continue;
    const id = (info as { id?: unknown }).id;
    const role = (info as { role?: unknown }).role;
    if (!pastUser) {
      if (id === userMessageId) pastUser = true;
      continue;
    }
    if (role === "assistant") out.push(m as { parts?: unknown[] });
  }
  return out;
}

function isAssistantTurnComplete(message: { parts?: unknown[] }): boolean {
  const parts = message.parts;
  if (!Array.isArray(parts) || parts.length === 0) return false;
  const last = parts[parts.length - 1] as { type?: unknown; reason?: unknown };
  if (last?.type !== "step-finish") return false;
  const reason = last?.reason;
  return reason === "stop" || reason === "length" || reason === "content-filter" || reason === "error";
}

async function resolveSessionId(
  client: OpencodeClient,
  existing: string | null,
): Promise<{ sessionId: string; recreated: boolean }> {
  if (existing) {
    const info = await client.getSession(existing).catch(() => null);
    if (info) return { sessionId: info.id, recreated: false };
    // Stale id (daemon's SQLite was wiped, workspace container was
    // removed and the bind-mount didn't survive, or the chat predates
    // the migration). Fall through and create fresh — and tell the
    // caller it happened so they can warn the user.
  }
  const created = await client.createSession();
  return { sessionId: created.id, recreated: existing !== null };
}

/**
 * Fixed in-container path the in-sandbox `desk-agent` CLI reads when
 * `DESK_SANDBOX_TOKEN` isn't set in its process env. The host driver
 * rewrites this file before each `sendMessage` with the current run's
 * token. Living under /tmp keeps it bound to the container's lifetime
 * (and away from the host-mounted workspace, so the token never ends
 * up on the host filesystem).
 */
const SANDBOX_TOKEN_PATH = "/tmp/desk-sandbox-token";

/**
 * Match the `ensureOpencodeServer` failures that mean "this attempt
 * needs a fresh container, not a debug session" —
 *
 * - Container vanished between createOrReuse and the spawn (reaper,
 *   drift-recreate, scheduler's parallel createOrReuse race).
 * - The ensure flow timed out (Docker socket wedged, daemon spawn
 *   stuck somewhere we can't bound). The upstream cache is already
 *   evicted; re-acquiring the container and retrying gives the next
 *   spawn a clean shot.
 *
 * The "No such container" / "No such object" forms are what Docker and
 * nerdctl actually emit when an exec races a removal — the older
 * `container X not found` form is rare in practice but kept for
 * compatibility.
 */
export function isContainerGoneError(message: string): boolean {
  return (
    /no such (container|object)/i.test(message) ||
    /container .* (not found|is not running)/i.test(message) ||
    /ensure timed out after/i.test(message)
  );
}

/**
 * Read the container's cgroup `memory.events.oom_kill` counter. A
 * non-zero value means the kernel SIGKILL'd at least one process for
 * over-memory. We use this after a daemon-gone error to distinguish
 * "transient network blip" from "the cgroup OOM-killed the daemon" —
 * the latter must reach the auto-scaler so the sandbox grows on
 * retry instead of failing again at the same memory limit.
 *
 * Works on cgroup v2 (`/sys/fs/cgroup/memory.events`) and v1
 * (`/sys/fs/cgroup/memory/memory.oom_control`). Returns 0 on any
 * read error — best-effort signal; the auto-scaler also handles
 * exit-code 137 separately for the cases where opencode wrappers
 * relay the SIGKILL exit.
 */
/**
 * Canonical stderr marker for an OOM-on-startup. Must contain the
 * lowercase substring `classifyResourceError` matches
 * (`opencode-serve was oom-killed`) so the scheduler's auto-scale path
 * fires on the next retry. Returns `""` when no OOM was observed so the
 * caller can interpolate unconditionally.
 */
function formatStartupOomMarker(oomBytes: number): string {
  if (oomBytes <= 0) return "";
  return (
    `\nopencode-serve was OOM-killed by the cgroup (memory.events oom_kill=${oomBytes}); ` +
    `flagging as ENOMEM so the sandbox grows on retry.`
  );
}

/**
 * Self-healing wrapper around `ensureOpencodeServer`. Catches every
 * recoverable daemon-start failure mode and retries, growing the
 * cgroup on OOM and re-acquiring the container on container-gone.
 *
 * Goal: chats succeed regardless of background sandbox churn. The
 * caller never sees intermediate failures via `onLog` — they only
 * reach server-side `log.warn(...)`. Only the final, exhausted-budget
 * failure becomes user-visible (the caller emits one clean stderr).
 *
 * Recovery topology per attempt:
 *   1. OOM (cgroup `memory.events.oom_kill` advanced) → call
 *      `growSandboxForResourceError("memory")` to double the limit
 *      in-place (no container recreate, so opencode-serve's
 *      persistent session state survives), invalidate the cached
 *      instance, retry.
 *   2. Container gone (inspect-not-found / not-running) → drop the
 *      cache entry, re-acquire via createOrReuse (which itself
 *      handles drift / port-bind races), retry.
 *   3. Anything else recoverable (ensure-timeout, waitForReady
 *      timeout, port not yet wired) → invalidate cache, retry. The
 *      RUNTIME's createOrReuse will see the container is healthy and
 *      reuse it; ensureOpencodeServer will spawn a fresh daemon.
 *
 * After DAEMON_ACQUIRE_MAX_ATTEMPTS the helper throws
 * `DaemonAcquireFailure`. The caller emits the user-visible stderr.
 */
const DAEMON_ACQUIRE_MAX_ATTEMPTS = 4;

interface AcquireDaemonOpts {
  engine: import("./engine.js").Engine;
  workspaceId: string;
  user: string;
  daemonEnv: Record<string, string>;
  initialHandle: { containerId: string; workspaceId: string };
  acquireHandle: () => Promise<{ containerId: string; workspaceId: string }>;
}

interface AcquireDaemonResult {
  handle: { containerId: string; workspaceId: string };
  server: OpencodeServerInstance;
}

/**
 * Structured failure thrown by `acquireDaemonWithRecovery` after every
 * recovery path is exhausted. Carries enough context for the caller's
 * single user-facing emit + server-log line.
 */
class DaemonAcquireFailure extends Error {
  readonly cause: Error;
  readonly kind: "oom" | "container-gone" | "ensure-timeout" | "unknown";
  readonly attempts: number;
  readonly recoveryEvents: Array<{
    attempt: number;
    action: string;
    detail?: string;
  }>;
  readonly lastOomKillCount: number;

  constructor(
    cause: Error,
    kind: DaemonAcquireFailure["kind"],
    attempts: number,
    recoveryEvents: DaemonAcquireFailure["recoveryEvents"],
    lastOomKillCount: number,
  ) {
    super(`daemon acquire failed after ${attempts} attempts: ${cause.message}`);
    this.name = "DaemonAcquireFailure";
    this.cause = cause;
    this.kind = kind;
    this.attempts = attempts;
    this.recoveryEvents = recoveryEvents;
    this.lastOomKillCount = lastOomKillCount;
  }
}

async function acquireDaemonWithRecovery(
  opts: AcquireDaemonOpts,
): Promise<AcquireDaemonResult> {
  const { engine, workspaceId, user, daemonEnv } = opts;
  let handle = opts.initialHandle;
  const recoveryEvents: DaemonAcquireFailure["recoveryEvents"] = [];
  let lastErr: Error = new Error("acquireDaemonWithRecovery: no attempts ran");
  let lastKind: DaemonAcquireFailure["kind"] = "unknown";
  let lastOomKillCount = 0;

  // Baseline OOM count at the start of this run. Each iteration
  // compares against this so we only react to *new* OOMs caused by
  // the daemon we just spawned, not stale counter values left from
  // an earlier turn on the same container.
  let oomBaseline = await readCgroupOomKillCount(engine, handle.containerId).catch(() => 0);

  for (let attempt = 0; attempt < DAEMON_ACQUIRE_MAX_ATTEMPTS; attempt++) {
    try {
      const server = await ensureOpencodeServer(engine, {
        containerId: handle.containerId,
        cwd: SANDBOX_HOME,
        user,
        env: daemonEnv,
      });
      if (attempt > 0) {
        log.info(
          { workspaceId, attempts: attempt + 1, recoveryEvents },
          "sandbox: recovered daemon after retries (invisible to user)",
        );
      }
      return { handle, server };
    } catch (err) {
      lastErr = err as Error;
      const msg = lastErr.message ?? String(lastErr);

      // Order matters: check OOM first (daemon was SIGKILL'd before
      // it could bind 9105, so the failure looks like "timeout"
      // /"no host-side binding" but the real fix is more memory).
      const currentOom = await readCgroupOomKillCount(engine, handle.containerId).catch(() => 0);
      if (currentOom > oomBaseline) {
        lastKind = "oom";
        lastOomKillCount = currentOom;
        const newKills = currentOom - oomBaseline;
        oomBaseline = currentOom;
        const { growSandboxForResourceError } = await import("./docker.js");
        const growth = await growSandboxForResourceError(workspaceId, "memory");
        const detail = growth.grew
          ? `grew memory to ${growth.memoryBytes} bytes`
          : growth.atMax
          ? `already at memory max (${growth.memoryBytes} bytes); will retry once more`
          : `growth refused (engine.update returned false)`;
        recoveryEvents.push({ attempt, action: "oom-grow", detail });
        log.warn(
          { workspaceId, containerId: handle.containerId, attempt, newKills, growth },
          "sandbox: opencode-serve OOM-killed during start; grew cgroup memory, retrying invisibly",
        );
        // The container survives `docker update`, but the daemon's
        // process is dead. Drop the cached URL so the next attempt
        // spawns a fresh one. opencode-serve persists session state
        // to HOME on disk, so session ids carry across the restart.
        invalidateOpencodeServerCache(handle.containerId);
        // If we couldn't grow (already at max) AND OOMs keep coming,
        // one more attempt won't help; bail to surface a real error.
        if (!growth.grew && growth.atMax) {
          throw new DaemonAcquireFailure(
            lastErr,
            "oom",
            attempt + 1,
            recoveryEvents,
            currentOom,
          );
        }
        continue;
      }

      if (isContainerGoneError(msg)) {
        lastKind = "container-gone";
        recoveryEvents.push({ attempt, action: "container-gone-reacquire", detail: msg });
        log.warn(
          { workspaceId, attempt, message: msg },
          "sandbox: container vanished mid-daemon-start; re-acquiring invisibly",
        );
        invalidateOpencodeServerCache(handle.containerId);
        handle = await opts.acquireHandle();
        // New container → new OOM baseline (the counter is per-cgroup).
        oomBaseline = await readCgroupOomKillCount(engine, handle.containerId).catch(() => 0);
        continue;
      }

      // Generic recoverable: an `ensure timed out`, a waitForReady
      // timeout, a port-not-yet-wired transient. The container is
      // (probably) fine; the daemon attempt isn't. Drop the cache
      // and let the next iteration spawn a fresh daemon.
      lastKind = "ensure-timeout";
      recoveryEvents.push({ attempt, action: "daemon-restart", detail: msg });
      log.warn(
        { workspaceId, containerId: handle.containerId, attempt, message: msg },
        "sandbox: opencode-serve start failed; restarting daemon invisibly",
      );
      invalidateOpencodeServerCache(handle.containerId);
    }
  }

  throw new DaemonAcquireFailure(
    lastErr,
    lastKind,
    DAEMON_ACQUIRE_MAX_ATTEMPTS,
    recoveryEvents,
    lastOomKillCount,
  );
}

async function readCgroupOomKillCount(
  engine: import("./engine.js").Engine,
  containerId: string,
): Promise<number> {
  const h = await engine.exec({
    containerId,
    cmd: [
      "sh", "-c",
      "(awk '/^oom_kill /{print $2}' /sys/fs/cgroup/memory.events 2>/dev/null) || " +
        "(awk '/^oom_kill /{print $2}' /sys/fs/cgroup/memory/memory.oom_control 2>/dev/null) || " +
        "echo 0",
    ],
  });
  const chunks: Buffer[] = [];
  h.stdout.on("data", (c: Buffer) => chunks.push(c));
  const code = await h.wait();
  if (code !== 0) return 0;
  const out = Buffer.concat(chunks).toString("utf8").trim();
  const n = parseInt(out, 10);
  return Number.isFinite(n) ? n : 0;
}

async function writeSandboxTokenFile(
  engine: import("./engine.js").Engine,
  containerId: string,
  user: string,
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
        `printf '%s' ${quoted} > ${SANDBOX_TOKEN_PATH}`,
      ].join(" && "),
    ],
  });
  const code = await h.wait();
  if (code !== 0) {
    throw new Error(`sandbox token write exited ${code}`);
  }
}

/**
 * Mirror managed-connection aliases from their canonical envKey so the
 * daemon sees both names with the same value. Matches the per-exec
 * `providerKeyExecEnv` semantics: e.g. if Settings stores `GITHUB_TOKEN`,
 * `GH_TOKEN` is emitted alongside with the same value so opencode's git
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
 * Assembles the opencode-serve daemon env. Disabled provider/connection
 * vars are emitted as empty strings, not omitted: the daemon is launched
 * via `docker exec` into a warm container whose create-time env still
 * holds whatever provider keys were active when it was first started.
 * An explicit `-e KEY=` from `docker exec` overrides that inherited
 * value for the daemon's process, so toggling a provider off in Settings
 * really hides it from opencode instead of leaking through the container
 * birth env. The blanks also feed into the env digest, so a toggle
 * invalidates the cached daemon and forces a fresh start.
 *
 * The same blanking applies to local-source env vars
 * (`LOCAL_SOURCE_ENV_NAMES`, e.g. Codex's `OPENCODE_AUTH_CONTENT`).
 * Cloud provider keys disable cleanly without this because their names
 * are part of `connectionEnvNames()`; local-source vars need their own
 * explicit blanks because they are NOT in that set and were silently
 * leaking from the container birth env into the daemon after the user
 * disabled the local source in Settings — keeping the daemon's stale
 * OAuth registration alive even when no auth was supposed to be
 * configured.
 *
 * Exported for direct unit testing — the integration path is exercised
 * indirectly through `execRun`, but the disabled-key override semantics
 * are easier to pin with a focused test on this helper.
 */
export function buildDaemonEnv(opts: {
  providerKeys?: Record<string, string>;
  extraEnv?: Record<string, string>;
  apiUrl?: string;
  /**
   * Hex digest of every agent file's `model:` line in the workspace's
   * `.opencode/agents/` directory. Threaded into the daemon env (as a
   * `DESK_*` sentinel the daemon itself ignores) so `ensureOpencodeServer`'s
   * env-digest compare picks up agent-file rewrites that would otherwise
   * be invisible — the daemon caches each agent's `model:` at startup
   * and ignores per-message `providerID`/`modelID` overrides for
   * agent-bound sessions. Without this, the fallback path that
   * rewrites `codex/X` → `opencode/big-pickle` (when auth is missing)
   * lands in the file but the daemon keeps using the cached old
   * model and every sendMessage fails with `fetch failed`.
   */
  agentFilesDigest?: string;
}): Record<string, string> {
  const blanks: Record<string, string> = {};
  for (const name of connectionEnvNames()) blanks[name] = "";
  for (const name of LOCAL_SOURCE_ENV_NAMES) blanks[name] = "";

  return {
    ...blanks,
    ...(opts.providerKeys ?? {}),
    ...(opts.extraEnv ?? {}),
    ...buildManagedConnectionAliases(opts.providerKeys),
    DESK_SANDBOX_TOKEN_PATH: SANDBOX_TOKEN_PATH,
    ...(opts.apiUrl ? { DESK_API_URL: opts.apiUrl } : {}),
    // Always emit, even when empty — an empty-vs-non-empty digest
    // transition must still flip the env-digest so an agents dir that
    // appeared/disappeared between spawns still triggers a restart.
    DESK_AGENT_FILES_MODEL_DIGEST: opts.agentFilesDigest ?? "",
  };
}
