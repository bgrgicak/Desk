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
 */
export function parseModelSpec(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) return { providerID: "opencode", modelID: model };
  return {
    providerID: model.slice(0, slash),
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

function createRealDriver(): SandboxDriver {
  return {
    async execRun(workspaceId, opts) {
      const { createOrReuse, sandboxUser } = await import("./docker.js");
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

      const user = await sandboxUser(engine);

      // Provider keys + extras + per-run sandbox auth all live in the
      // daemon's env. A change in any of these (e.g. a refreshed
      // OPENCODE_API_KEY) restarts the daemon — `ensureOpencodeServer`
      // diffs the env digest and rebuilds on mismatch.
      const daemonEnv: Record<string, string> = {
        ...(opts.providerKeys ?? {}),
        ...(opts.extraEnv ?? {}),
        ...(opts.sandboxToken ? { DESK_SANDBOX_TOKEN: opts.sandboxToken } : {}),
        ...(opts.apiUrl ? { DESK_API_URL: opts.apiUrl } : {}),
        ...buildManagedConnectionEnv(opts.providerKeys, opts.extraEnv),
      };

      let server: OpencodeServerInstance;
      try {
        server = await ensureOpencodeServer(engine, {
          containerId: handle.containerId,
          cwd: SANDBOX_HOME,
          user,
          env: daemonEnv,
        });
      } catch (err) {
        await opts.onLog({
          runId: opts.runId,
          seq: 0,
          kind: "stderr",
          payload: `opencode-serve failed to start: ${(err as Error).message ?? String(err)}`,
        });
        return { exitCode: 1 };
      }

      const client = new OpencodeClient(server.url, server.password);
      const sessionId = await resolveSessionId(client, opts.opencodeSessionId ?? null);

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

      try {
        await client.sendMessage(sessionId, {
          providerID,
          modelID,
          parts,
          ...(opts.agentFileId ? { agent: opts.agentFileId } : {}),
        });
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

async function resolveSessionId(
  client: OpencodeClient,
  existing: string | null,
): Promise<string> {
  if (existing) {
    const info = await client.getSession(existing).catch(() => null);
    if (info) return info.id;
    // Stale id (server's SQLite was wiped, or chat predates the
    // migration). Fall through and create fresh.
  }
  const created = await client.createSession();
  return created.id;
}

/**
 * Build managed-connection env entries (today: GitHub askpass token) that
 * used to be set up by an in-container shell prefix before each
 * `opencode run` invocation. With a long-lived daemon, those vars become
 * part of the daemon's env. The shape is unchanged from
 * `managedConnectionDefinitions().sandboxSetup` callers — we just pre-
 * format them as env entries instead of shell snippets.
 */
function buildManagedConnectionEnv(
  providerKeys?: Record<string, string>,
  extraEnv?: Record<string, string>,
): Record<string, string> {
  const source: Record<string, string | undefined> = {
    ...(providerKeys ?? {}),
    ...(extraEnv ?? {}),
  };
  const env: Record<string, string> = {};
  // The previous `buildSandboxAuthSetup` walked
  // `managedConnectionDefinitions()` looking for `sandboxSetup` entries.
  // The only entry today (`github-askpass`) needs `GITHUB_TOKEN`/`GH_TOKEN`
  // visible to opencode so its tool calls can authenticate with git. Both
  // already flow through `providerKeyExecEnv` today; surface them here so
  // a future managed connection that introduces a new auth-style env
  // gets picked up the same way.
  for (const definition of managedConnectionDefinitions()) {
    if (!definition.sandboxSetup) continue;
    const names = [definition.envKey, ...(definition.envAliases ?? [])];
    for (const name of names) {
      const v = source[name];
      if (v && v.length > 0) env[name] = v;
    }
  }
  return env;
}
