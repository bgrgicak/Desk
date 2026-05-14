/**
 * Thin HTTP client + SSE multiplexer for an `opencode serve` instance.
 *
 * The OpenAPI exposed at `/doc` is incomplete — only `/auth/*` and `/log`
 * are listed there. The rest of the routes used below were verified by
 * probing a running 1.14.41 server. Shapes are checked at runtime by
 * tolerant parsers (Zod-light) so a future minor opencode version that
 * adds optional fields doesn't break us.
 */

import { readOpencodeSseEvents, type OpencodeSseEvent } from "./opencodeEvents.js";

export interface OpencodeSessionInfo {
  id: string;
  /** Workspace dir the session is anchored to (server cwd). */
  directory?: string;
  /** Server-assigned project id; opaque to us. */
  projectID?: string;
  slug?: string;
}

export interface SendMessageInput {
  providerID: string;
  modelID: string;
  /** Already-shaped opencode message parts; the driver builds these from the prompt + attachments. */
  parts: unknown[];
  /** Override the session's default agent for this message (`build`, `summary`, …). Optional. */
  agent?: string;
  /** Optional id; useful when the caller wants to correlate to the resulting `msg_…` row. */
  messageID?: string;
}

export class OpencodeServerError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: string) {
    super(message);
    this.name = "OpencodeServerError";
  }
}

/**
 * Caller-facing client. One instance per `(url, password)` pair; safe to
 * share across calls. Holds at most one persistent SSE connection (opened
 * lazily on first `subscribeSessionEvents`).
 */
export class OpencodeClient {
  private sseTask: Promise<void> | null = null;
  private sseAbort: AbortController | null = null;
  private subscribers = new Map<string, Set<(evt: OpencodeSseEvent) => void>>();
  /** Listeners that fire when the SSE stream ends (server died or shut down). */
  private streamEndListeners = new Set<(err: Error | null) => void>();
  /**
   * Resolves the first time the SSE stream emits `server.connected` —
   * the signal from `opencode serve` that our subscription is registered
   * server-side. Callers should `await client.sseReady()` *before*
   * dispatching a message that they expect to receive events for, or
   * those events can race past an SSE socket that's still mid-handshake.
   */
  private sseReadyResolvers: Array<() => void> = [];
  private sseReadyError: Error | null = null;
  private sseReady_ = false;

  constructor(public readonly url: string, public readonly password: string) {}

  /**
   * `opencode serve` uses HTTP Basic auth with a fixed username
   * (`opencode`, override via `OPENCODE_SERVER_USERNAME`) and the
   * `OPENCODE_SERVER_PASSWORD`. The Bearer scheme is NOT supported.
   */
  private authHeader(): string {
    const credentials = Buffer.from(`opencode:${this.password}`).toString("base64");
    return `Basic ${credentials}`;
  }

  // -------- Session CRUD ------------------------------------------------

  async createSession(): Promise<OpencodeSessionInfo> {
    return this.post<OpencodeSessionInfo>("/session", {});
  }

  /** Returns null when the session id no longer exists on the server. */
  async getSession(id: string): Promise<OpencodeSessionInfo | null> {
    const r = await this.fetchRaw(`/session/${encodeURIComponent(id)}`, { method: "GET" });
    if (r.status === 404) return null;
    if (!r.ok) throw await this.toError(r, "GET /session/:id");
    return (await r.json()) as OpencodeSessionInfo;
  }

  async deleteSession(id: string): Promise<void> {
    const r = await this.fetchRaw(`/session/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw await this.toError(r, "DELETE /session/:id");
  }

  /** Aborts the session's currently-running message (if any). Resolves true on success. */
  async abortSession(id: string): Promise<boolean> {
    const r = await this.fetchRaw(`/session/${encodeURIComponent(id)}/abort`, { method: "POST" });
    if (r.status === 404) return false;
    if (!r.ok) throw await this.toError(r, "POST /session/:id/abort");
    return true;
  }

  // -------- Message dispatch -------------------------------------------

  /**
   * Sends a message and awaits the assistant turn to complete. Returns
   * the assistant message envelope. SSE events stream over the separate
   * `subscribeSessionEvents` channel — this method just round-trips the
   * synchronous run/response.
   */
  async sendMessage(sessionId: string, input: SendMessageInput): Promise<unknown> {
    return this.post(`/session/${encodeURIComponent(sessionId)}/message`, {
      providerID: input.providerID,
      modelID: input.modelID,
      parts: input.parts,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.messageID ? { messageID: input.messageID } : {}),
    });
  }

  // -------- SSE multiplexer --------------------------------------------

  /**
   * Subscribe to events for one session. The returned function
   * unsubscribes. The SSE connection is opened lazily on first subscribe
   * and stays open until `close()` is called (or the stream ends because
   * the server died).
   */
  subscribeSessionEvents(
    sessionId: string,
    onEvent: (evt: OpencodeSseEvent) => void,
  ): () => void {
    let subs = this.subscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(sessionId, subs);
    }
    subs.add(onEvent);
    this.ensureSseConnection();
    return () => {
      const s = this.subscribers.get(sessionId);
      if (!s) return;
      s.delete(onEvent);
      if (s.size === 0) this.subscribers.delete(sessionId);
    };
  }

  /** Fires once when the SSE stream ends (server died or `close()` was called). */
  onStreamEnd(listener: (err: Error | null) => void): () => void {
    this.streamEndListeners.add(listener);
    return () => this.streamEndListeners.delete(listener);
  }

  /**
   * Resolves when the SSE stream has produced its initial
   * `server.connected` event. Callers (the driver) `await` this before
   * dispatching a message so we never lose the per-message events to a
   * race against a still-handshaking SSE socket.
   */
  sseReady(): Promise<void> {
    if (this.sseReady_) return Promise.resolve();
    if (this.sseReadyError) return Promise.reject(this.sseReadyError);
    this.ensureSseConnection();
    return new Promise<void>((resolve) => {
      if (this.sseReady_) {
        resolve();
        return;
      }
      this.sseReadyResolvers.push(resolve);
    });
  }

  /** Closes the SSE stream and clears subscribers. Idempotent. */
  close(): void {
    this.subscribers.clear();
    this.sseAbort?.abort();
    this.sseAbort = null;
    this.sseTask = null;
  }

  private ensureSseConnection(): void {
    if (this.sseTask) return;
    const abort = new AbortController();
    this.sseAbort = abort;
    this.sseTask = this.runSseLoop(abort.signal).finally(() => {
      this.sseTask = null;
      this.sseAbort = null;
    });
  }

  private async runSseLoop(signal: AbortSignal): Promise<void> {
    let endError: Error | null = null;
    try {
      const r = await fetch(`${this.url}/event`, {
        headers: { Authorization: this.authHeader(), Accept: "text/event-stream" },
        signal,
      });
      if (!r.ok || !r.body) {
        throw new OpencodeServerError(
          `GET /event returned status ${r.status}`,
          r.status,
          r.body ? await safeText(r) : undefined,
        );
      }
      for await (const evt of readOpencodeSseEvents(r.body)) {
        // The very first event on a fresh /event stream is
        // `server.connected` — opencode emits it as the synchronous
        // ack that our subscription is registered. Use it to release
        // any `sseReady()` waiters.
        if (evt.type === "server.connected" && !this.sseReady_) {
          this.sseReady_ = true;
          const waiters = this.sseReadyResolvers.slice();
          this.sseReadyResolvers.length = 0;
          for (const r of waiters) r();
          continue;
        }
        const sessionID = (evt.properties as { sessionID?: string } | undefined)?.sessionID;
        if (!sessionID) continue;
        const subs = this.subscribers.get(sessionID);
        if (!subs || subs.size === 0) continue;
        for (const fn of subs) {
          try {
            fn(evt);
          } catch (err) {
            // A bad subscriber shouldn't kill the multiplexer.
            // eslint-disable-next-line no-console
            console.warn("opencodeClient: subscriber threw", err);
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name !== "AbortError") {
        endError = err as Error;
      }
    } finally {
      // Release any waiters for sseReady() that never saw a
      // server.connected event so they don't hang forever.
      if (!this.sseReady_) {
        this.sseReadyError = endError ?? new Error("SSE stream closed before server.connected");
        const waiters = this.sseReadyResolvers.slice();
        this.sseReadyResolvers.length = 0;
        for (const w of waiters) w();
      }
      const listeners = Array.from(this.streamEndListeners);
      this.streamEndListeners.clear();
      for (const fn of listeners) {
        try {
          fn(endError);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("opencodeClient: stream-end listener threw", err);
        }
      }
    }
  }

  // -------- Low-level helpers ------------------------------------------

  private async post<T>(path: string, body: unknown): Promise<T> {
    const r = await this.fetchRaw(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw await this.toError(r, `POST ${path}`);
    // Many opencode endpoints return JSON; a few (DELETE on session) return `true`.
    // We always parse as JSON when content-type is JSON, else text.
    const ct = r.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return (await r.json()) as T;
    return (await r.text()) as unknown as T;
  }

  private async fetchRaw(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${this.url}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: this.authHeader(),
      },
    });
  }

  private async toError(r: Response, label: string): Promise<OpencodeServerError> {
    const body = await safeText(r);
    return new OpencodeServerError(`${label} returned ${r.status}: ${body}`, r.status, body);
  }
}

async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 2048);
  } catch {
    return "";
  }
}

/** True iff `err` looks like the server stopped accepting connections (ECONNREFUSED etc.). */
export function isServerGoneError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { cause?: { code?: string }; code?: string; message?: string };
  const code = e.cause?.code ?? e.code ?? "";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND") return true;
  const msg = (e.message ?? "").toLowerCase();
  return (
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("fetch failed")
  );
}
