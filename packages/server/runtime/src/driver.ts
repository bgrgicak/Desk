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

import { SANDBOX_HOME } from "./mounts.js";
import { managedConnectionDefinitions } from "@agent-desk/shared";
import { connectionEnvNames } from "./docker.js";
import { OpencodeClient, OpencodeServerError, isServerGoneError } from "./opencodeClient.js";
import { translateOpencodeSseEvent } from "./opencodeEvents.js";
import {
  ensureOpencodeServer,
  invalidateOpencodeServerCache,
  type OpencodeServerInstance,
} from "./opencodeServer.js";

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
          undefined,
          opts.extraEnv,
        );

      let handle = await acquireHandle();

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
      const daemonEnv = buildDaemonEnv({
        providerKeys: opts.providerKeys,
        extraEnv: opts.extraEnv,
        apiUrl: opts.apiUrl,
      });

      // The container can disappear between createOrReuse and
      // ensureOpencodeServer — the scheduler also calls createOrReuse
      // upstream with a different mountPlan, so a drift recheck here
      // can race with a reaper or another fire that just removed the
      // container. When we hit "not found" / "is not running", drop
      // the stale cache entry, re-acquire the container, and try once
      // more before giving up. A single retry covers the race window
      // without masking persistent failures (those still bail).
      let server: OpencodeServerInstance;
      try {
        server = await ensureOpencodeServer(engine, {
          containerId: handle.containerId,
          cwd: SANDBOX_HOME,
          user,
          env: daemonEnv,
        });
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (isContainerGoneError(msg)) {
          invalidateOpencodeServerCache(handle.containerId);
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
              payload: `opencode-serve failed to start (after container re-acquire): ${(retryErr as Error).message ?? String(retryErr)}`,
            });
            return { exitCode: 1 };
          }
        } else {
          await opts.onLog({
            runId: opts.runId,
            seq: 0,
            kind: "stderr",
            payload: `opencode-serve failed to start: ${msg}`,
          });
          return { exitCode: 1 };
        }
      }

      const client = new OpencodeClient(server.url, server.password);

      // Write the per-run sandbox token to the daemon's container at
      // the stable path the in-sandbox CLI reads. Writing per-run keeps
      // the daemon's env digest stable across runs (no restart per
      // turn) while still rotating identity per chat-turn. Skipped when
      // no token was minted (older callers).
      if (opts.sandboxToken) {
        await writeSandboxTokenFile(engine, handle.containerId, user, opts.sandboxToken).catch(
          (err) => {
            console.warn(
              `runtime: failed to write sandbox token file (runId=${opts.runId}):`,
              (err as Error)?.message ?? err,
            );
          },
        );
      }

      const sessionResolution = await resolveSessionId(client, opts.opencodeSessionId ?? null);
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

      // Wire SSE subscription before sending the message so we don't miss
      // early events. The multiplexer dedups its own connection.
      let seq = 0;
      const pendingLogs: Promise<unknown>[] = [];
      const emitLog = (kind: LogEvent["kind"], payload: string) => {
        const ret = opts.onLog({ runId: opts.runId, seq: seq++, kind, payload });
        if (ret && typeof (ret as Promise<unknown>).then === "function") {
          pendingLogs.push((ret as Promise<unknown>).catch(() => {}));
        }
      };

      const unsubscribe = client.subscribeSessionEvents(sessionId, (sseEvent) => {
        const line = translateOpencodeSseEvent(sseEvent, { sessionID: sessionId });
        if (line !== null) emitLog("event", line);
      });

      // Wait until the SSE stream has acknowledged our subscription
      // before dispatching the message — otherwise the per-message
      // events emitted in the first ~ms can race past a still-
      // handshaking SSE socket and never reach `onLog`.
      try {
        await client.sseReady();
      } catch (err) {
        emitLog("stderr", `opencode-serve event stream failed to open: ${(err as Error).message ?? String(err)}`);
        unsubscribe();
        activeRuns.delete(opts.runId);
        return { exitCode: 1, opencodeSessionId: sessionId };
      }

      const tracked: ActiveRun = {
        containerId: handle.containerId,
        sessionId,
        client,
        unsubscribeSse: unsubscribe,
        abortRequested: false,
      };
      activeRuns.set(opts.runId, tracked);

      const model = opts.model ?? "opencode/big-pickle";
      const { providerID, modelID } = parseModelSpec(model);
      const parts = buildMessageParts({
        prompt: opts.prompt,
        attachments: opts.attachments,
      });

      // opencode-serve 1.14.50 only broadcasts text/reasoning deltas
      // over SSE. Tool calls, step-start, step-finish parts are
      // written to its SQLite during the turn and only readable via
      // `GET /session/:id/message`. To make tool cards appear as they
      // happen rather than only after sendMessage returns, we poll
      // listSessionMessages every ~500ms during the turn and emit any
      // non-text part not yet seen. The same `partState` set is
      // reused by the post-turn backstop loop so nothing double-emits.
      const partState: PartEmissionState = new Map();
      // Snapshot the existing assistant-message IDs so the polling
      // loop can ignore prior turns that share this session. Cap the
      // call at 3s — when the daemon is unresponsive (just spawned,
      // mid-restart), an unbounded await here parks the entire run
      // before sendMessage ever fires. An empty baseline only causes
      // the polling loop to briefly re-emit prior parts, which is
      // harmless (the next part-state-key check filters them).
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
        // best-effort — empty baseline means we may briefly emit a
        // prior turn's tool parts on the first poll, which is
        // harmless (they're already in the chat log).
      }

      let pollingDone = false;
      const pollInterval = 500;
      const pollTask = (async () => {
        while (!pollingDone) {
          await new Promise((r) => setTimeout(r, pollInterval));
          if (pollingDone) break;
          try {
            const messages = await client.listSessionMessages(sessionId);
            for (const m of messages) {
              if (!m || typeof m !== "object") continue;
              const info = (m as { info?: { id?: unknown; role?: unknown } }).info;
              const id = info && typeof info === "object" ? (info as { id?: unknown }).id : undefined;
              const role = info && typeof info === "object" ? (info as { role?: unknown }).role : undefined;
              if (typeof id !== "string" || baselineMessageIds.has(id)) continue;
              if (role !== "assistant") continue;
              for (const line of synthesizeNonTextEvents(m, sessionId, partState)) {
                emitLog("event", line);
              }
            }
          } catch {
            // Transient daemon hiccup; next tick will retry.
          }
        }
      })();

      try {
        const response = (await client.sendMessage(sessionId, {
          providerID,
          modelID,
          parts,
          ...(opts.agentFileId ? { agent: opts.agentFileId } : {}),
        })) as { info?: { id?: string } };
        // After sendMessage settles, do one final synchronous pass to
        // capture parts the daemon committed in the last poll
        // interval. `partState` keeps it from re-emitting anything
        // the live loop already surfaced.
        const finalAssistantInfo = response.info as { id?: string; parentID?: string } | undefined;
        const finalAssistantId = finalAssistantInfo?.id;
        const userMessageId = finalAssistantInfo?.parentID;
        if (userMessageId && finalAssistantId) {
          try {
            // opencode emits ONE assistant message per "step" in a
            // multi-step turn — tool calls force a step boundary, so
            // a single user prompt that triggers a Read tool produces
            // two assistant messages: the first containing
            // step-start/reasoning/tool/step-finish, the second
            // containing step-start/reasoning/text/step-finish.
            // `sendMessage` returns the LAST message (the answer); the
            // tool part lives in the first one. Synth from EVERY
            // assistant message in this turn — anything newer than the
            // user message we just dispatched.
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
            // Best-effort — losing tool-card synthesis shouldn't fail
            // the run.
            console.warn(
              `runtime: listSessionMessages failed (runId=${opts.runId}):`,
              (err as Error)?.message ?? err,
            );
          }
        }
        await Promise.all(pendingLogs);
        return {
          exitCode: tracked.abortRequested ? 130 : 0,
          opencodeSessionId: sessionId,
        };
      } catch (err) {
        if (tracked.abortRequested) {
          // The abort path already surfaced a log line. Treat the
          // resulting HTTP error as expected.
          await Promise.all(pendingLogs);
          return { exitCode: 130, opencodeSessionId: sessionId };
        }
        const message = (err as Error).message ?? String(err);
        emitLog("stderr", `opencode-serve message failed: ${message}`);
        if (isServerGoneError(err)) {
          // Cached URL points at a dead daemon; clear it so the next call
          // re-spawns. We don't retry inside this call because the model
          // may have moved on (e.g. message accepted, response failed).
          invalidateOpencodeServerCache(handle.containerId);
          // If the cgroup OOM-killed the daemon, surface the canonical
          // ENOMEM line so `classifyResourceError` returns "memory" and
          // the scheduler's auto-scale + retry path kicks in. Without
          // this, a memory-bound daemon crash looks like a transient
          // network blip and the user sees a one-shot failure with no
          // grow.
          const oomBytes = await readCgroupOomKillCount(engine, handle.containerId).catch(() => 0);
          if (oomBytes > 0) {
            emitLog(
              "stderr",
              `opencode-serve was OOM-killed by the cgroup (memory.events oom_kill=${oomBytes}); ` +
                `flagging as ENOMEM so the sandbox grows on retry.`,
            );
          }
        } else if (err instanceof OpencodeServerError && err.status === 404) {
          // Session id stale (e.g. server's SQLite was wiped). Forget the
          // session so the next turn creates a fresh one.
          await client.deleteSession(sessionId).catch(() => {});
          await Promise.all(pendingLogs);
          return { exitCode: 1 };
        }
        await Promise.all(pendingLogs);
        return { exitCode: 1, opencodeSessionId: sessionId };
      } finally {
        // Stop the live-poll loop in every exit path (success, error,
        // abort) so it doesn't keep running and emit phantom events
        // for the next turn.
        pollingDone = true;
        await pollTask;
        activeRuns.delete(opts.runId);
        unsubscribe();
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

/**
 * Walk a `sendMessage` response and emit synthetic run-format events
 * for every non-text part the daemon's SSE stream didn't already
 * broadcast. opencode-serve 1.14.50 only streams `message.part.delta`
 * events with `field: "text"` — tool, step-start, step-finish, and
 * reasoning parts never appear on the wire, only in the final
 * message envelope. Without this synthesis the UI never sees tool
 * cards or step boundaries.
 *
 * Returns an iterator of JSON-string events ready for the `kind:
 * "event"` log channel. Same shape as the SSE translator's output:
 * `{type, part, sessionID}` with the part.type hyphens normalized to
 * underscores so consumers see `step_start` / `step_finish` etc.
 */
/**
 * Per-part state tracked across polling iterations so we can emit
 * meaningful updates without double-rendering. Replaces the older
 * Set-of-ids dedup so we can emit reasoning-text deltas (the daemon
 * doesn't broadcast them over SSE) and tool state transitions while
 * still collapsing static parts to a single emission.
 */
export type PartEmissionState = Map<
  string,
  { reasoningTextEmitted?: number; toolStatus?: string; emitted?: boolean }
>;

export function* synthesizeNonTextEvents(
  messageOrEnvelope: unknown,
  sessionID: string,
  state?: PartEmissionState,
): Iterable<string> {
  if (!messageOrEnvelope || typeof messageOrEnvelope !== "object") return;
  // Accept either the raw assistant-message envelope `{info, parts}`
  // or just the inner message shape with a top-level `parts`.
  const env = messageOrEnvelope as { parts?: unknown; info?: unknown };
  if (!Array.isArray(env.parts)) return;
  // Pull the providerID/modelID/agent/mode the daemon actually used for
  // this assistant message. Surfacing it on every synthesized event
  // makes "what model produced this step?" answerable from the chat
  // log alone — invaluable when a session was bound to one model and
  // an upstream switch didn't propagate.
  const meta = extractAssistantInfoMeta(env.info);
  for (const partRaw of env.parts) {
    if (!partRaw || typeof partRaw !== "object") continue;
    const part = partRaw as { type?: unknown; id?: unknown; text?: unknown; state?: unknown };
    if (typeof part.type !== "string") continue;
    // Text parts already streamed via SSE deltas; re-emitting them
    // would duplicate the message body when `deriveTextFromLog`
    // concatenates `text` events.
    if (part.type === "text") continue;

    const partId = typeof part.id === "string" ? part.id : "";
    const prior = state && partId ? state.get(partId) ?? {} : {};

    // Reasoning: opencode-serve doesn't reliably broadcast reasoning
    // deltas over SSE for multi-step turns, so the polling loop is
    // the only path that sees reasoning growing. Mimic the SSE
    // delta shape — emit just the suffix added since the last
    // observation — so the UI streams reasoning text the same way
    // it streams the final answer.
    if (part.type === "reasoning") {
      const fullText = typeof part.text === "string" ? part.text : "";
      const previouslyEmitted = prior.reasoningTextEmitted ?? 0;
      if (fullText.length <= previouslyEmitted) {
        // Same text we already emitted (or shorter — daemon shouldn't
        // ever shorten). Nothing to do.
        if (state && partId) state.set(partId, prior);
        continue;
      }
      const delta = fullText.slice(previouslyEmitted);
      const deltaPart: Record<string, unknown> = {
        type: "reasoning",
        text: delta,
        id: partId,
      };
      const messageID = (part as { messageID?: unknown }).messageID;
      if (typeof messageID === "string") deltaPart.messageID = messageID;
      const event: Record<string, unknown> = { type: "reasoning", part: deltaPart, sessionID };
      if (meta) event.model = meta;
      if (state && partId) state.set(partId, { ...prior, reasoningTextEmitted: fullText.length });
      yield JSON.stringify(event);
      continue;
    }

    // Tool parts mutate as the call moves through pending → running
    // → completed/error. Emit on every status transition so the UI
    // sees the tool card update; collapse repeated observations of
    // the same status.
    if (part.type === "tool") {
      const status = (part.state as { status?: unknown } | undefined)?.status;
      const statusStr = typeof status === "string" ? status : "";
      if (state && partId && prior.toolStatus === statusStr) continue;
      const event: Record<string, unknown> = { type: "tool", part, sessionID };
      if (meta) event.model = meta;
      if (state && partId) state.set(partId, { ...prior, toolStatus: statusStr });
      yield JSON.stringify(event);
      continue;
    }

    // Static parts (step-start, step-finish, …) — emit exactly once.
    if (state && partId) {
      if (prior.emitted) continue;
      state.set(partId, { ...prior, emitted: true });
    }
    const runFormatType = part.type.replace(/-/g, "_");
    const event: Record<string, unknown> = { type: runFormatType, part, sessionID };
    if (meta) event.model = meta;
    yield JSON.stringify(event);
  }
}

/**
 * Extract the `{providerID, modelID, agent?, mode?}` debug summary from an
 * assistant-message `info` envelope returned by opencode-serve's
 * `GET /session/:id/message`. Returns null when the envelope is missing
 * the fields — better to omit the model annotation than to write
 * misleading partial data.
 */
function extractAssistantInfoMeta(info: unknown): {
  providerID: string;
  modelID: string;
  agent?: string;
  mode?: string;
} | null {
  if (!info || typeof info !== "object") return null;
  const i = info as { providerID?: unknown; modelID?: unknown; agent?: unknown; mode?: unknown };
  if (typeof i.providerID !== "string" || typeof i.modelID !== "string") return null;
  const out: { providerID: string; modelID: string; agent?: string; mode?: string } = {
    providerID: i.providerID,
    modelID: i.modelID,
  };
  if (typeof i.agent === "string") out.agent = i.agent;
  if (typeof i.mode === "string") out.mode = i.mode;
  return out;
}

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
 */
export function isContainerGoneError(message: string): boolean {
  return (
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
 * Exported for direct unit testing — the integration path is exercised
 * indirectly through `execRun`, but the disabled-key override semantics
 * are easier to pin with a focused test on this helper.
 */
export function buildDaemonEnv(opts: {
  providerKeys?: Record<string, string>;
  extraEnv?: Record<string, string>;
  apiUrl?: string;
}): Record<string, string> {
  const blanks: Record<string, string> = {};
  for (const name of connectionEnvNames()) blanks[name] = "";

  return {
    ...blanks,
    ...(opts.providerKeys ?? {}),
    ...(opts.extraEnv ?? {}),
    ...buildManagedConnectionAliases(opts.providerKeys),
    DESK_SANDBOX_TOKEN_PATH: SANDBOX_TOKEN_PATH,
    ...(opts.apiUrl ? { DESK_API_URL: opts.apiUrl } : {}),
  };
}
