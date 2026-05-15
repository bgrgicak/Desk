/**
 * Translates `opencode serve` SSE events into the run-format JSON event
 * shape consumed by the rest of Desk (the `AgentEventSchema` and its
 * downstream readers in `scheduler/runs.ts` / `compose/ChatThread.tsx`).
 *
 * Why a translator: `opencode serve` exposes events via an SSE stream
 * (`GET /event`) using its internal bus shape — events like
 * `message.part.updated` whose payload's `part.type` is hyphenated
 * (`step-start`). The wire format consumed by the rest of Desk comes
 * from `opencode run --format json`, which emits the part as a top-level
 * line with an underscored type (`step_start`). To keep downstream
 * consumers untouched, we translate at the driver boundary.
 *
 * Translation rules:
 *
 * - `message.part.updated` whose `properties.sessionID === filter.sessionID`
 *   → emit one line `{ type: <part.type with - → _>, part, sessionID }`.
 * - Anything else (other event types, other sessions, delta events, server
 *   connect/busy/idle, file watcher) → drop.
 *
 * We deliberately ignore `message.part.delta`: the SSE stream emits both
 * `.delta` (incremental) and `.updated` (consolidated) for the same part.
 * The downstream consumer expects the consolidated shape; surfacing both
 * would duplicate text.
 */

export interface OpencodeSseEvent {
  /** Event-bus type, e.g. "message.part.updated". */
  type: string;
  properties?: Record<string, unknown>;
}

export interface TranslateFilter {
  /** Only events tagged with this session id are translated; others drop. */
  sessionID: string;
}

/**
 * Maps an SSE event to a single run-format JSON line (string) or null when
 * the event doesn't belong to our session or isn't translatable.
 *
 * Two SSE shapes are translated:
 *
 * 1. `message.part.updated` (older opencode releases): the consolidated
 *    snapshot of a part. We emit `{type: <part.type with - → _>, part, sessionID}`.
 *
 * 2. `message.part.delta` (current opencode releases 1.14.50+): a per-
 *    chunk delta carrying `{partID, field, delta}`. The `field` is the
 *    name of the part attribute being appended to (typically `"text"`,
 *    also `"reasoning"` etc.). We emit `{type: <field>, part: {type: <field>, text: <delta>, id: <partID>}, sessionID}`
 *    — one event per chunk. The scheduler's `deriveTextFromLog`
 *    concatenates `part.text` across `text`-typed events, so feeding it
 *    one event per delta reconstructs the full message text correctly.
 */
export function translateOpencodeSseEvent(
  sse: OpencodeSseEvent,
  filter: TranslateFilter,
): string | null {
  const props = sse.properties;
  if (!props || typeof props !== "object") return null;
  const sessionID = (props as { sessionID?: unknown }).sessionID;
  if (typeof sessionID !== "string") return null;
  if (sessionID !== filter.sessionID) return null;

  if (sse.type === "message.part.updated") {
    const partRaw = (props as { part?: unknown }).part;
    if (!partRaw || typeof partRaw !== "object") return null;
    const part = partRaw as { type?: unknown };
    const partType = part.type;
    if (typeof partType !== "string") return null;
    const runFormatType = partType.replace(/-/g, "_");
    return JSON.stringify({ type: runFormatType, part, sessionID });
  }

  if (sse.type === "message.part.delta") {
    const p = props as {
      partID?: unknown;
      field?: unknown;
      delta?: unknown;
      messageID?: unknown;
    };
    if (typeof p.field !== "string") return null;
    if (typeof p.delta !== "string") return null;
    const runFormatType = p.field.replace(/-/g, "_");
    // The downstream `AgentEventSchema` reads `part.text` for `text`-typed
    // events. For other delta fields (e.g. `reasoning`) the same shape
    // works — consumers that care look at the matching `part.<field>`,
    // or `part.text` when field is "text".
    const part: Record<string, unknown> = {
      type: runFormatType,
      text: p.delta,
    };
    if (typeof p.partID === "string") part.id = p.partID;
    if (typeof p.messageID === "string") part.messageID = p.messageID;
    return JSON.stringify({ type: runFormatType, part, sessionID });
  }

  return null;
}

/**
 * Parses an SSE byte stream into discrete events. The stream is the raw
 * `text/event-stream` body from `GET /event` — events are separated by a
 * blank line and prefixed with `data: `. We accumulate `data:` lines until
 * the blank line, then JSON-parse the joined payload. Malformed events are
 * skipped (we log to stderr) so a single bad frame doesn't kill the stream.
 *
 * The returned iterator completes when the body ends (server closes the
 * stream or the consumer aborts the fetch).
 */
export async function* readOpencodeSseEvents(
  body: ReadableStream<Uint8Array>,
  opts: { onParseError?: (raw: string, err: unknown) => void } = {},
): AsyncIterable<OpencodeSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE event delimiter: \n\n (or \r\n\r\n). Split eagerly so events
      // surface to the consumer as soon as the server flushes them.
      let sep: number;
      while ((sep = nextEventBoundary(buffer)) >= 0) {
        const rawFrame = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(?:\r?\n){1,2}/, "");
        const evt = parseEventFrame(rawFrame, opts.onParseError);
        if (evt) yield evt;
      }
    }
    // Trailing frame, if any.
    if (buffer.trim().length > 0) {
      const evt = parseEventFrame(buffer, opts.onParseError);
      if (evt) yield evt;
    }
  } finally {
    reader.releaseLock?.();
  }
}

function nextEventBoundary(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

function parseEventFrame(
  frame: string,
  onParseError?: (raw: string, err: unknown) => void,
): OpencodeSseEvent | null {
  // An SSE event is a series of "field: value" lines. We only care about
  // `data:`; other fields (id, retry, event) are accepted but unused.
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
      return parsed as OpencodeSseEvent;
    }
    return null;
  } catch (err) {
    onParseError?.(raw, err);
    return null;
  }
}
