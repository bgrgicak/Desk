/**
 * Translates pi's `--mode json` event stream into the run-format JSON
 * events Desk's scheduler + UI already know how to consume.
 *
 * The downstream consumers (scheduler/runs-helpers.ts, app's
 * MessageBubble/messageVisibility) read a small set of `type` values
 * from `{type, part, sessionID}` envelopes:
 *
 *   - `text`       — incremental text deltas. UI concatenates `part.text`
 *                    by `part.id`.
 *   - `reasoning`  — incremental reasoning deltas; UI hides matching
 *                    text-part ids.
 *   - `tool`       — consolidated tool-call shape with `part.state.status`
 *                    transitions; the UI also accepts `tool_use`/`tool_call`/
 *                    `tool_result` forms via tolerant label code.
 *   - `step_start` / `step_finish` — turn boundary markers.
 *   - `error`-shaped — anything matching `/error|failed|exception/i`.
 *
 * Pi emits its own typed event union (see pi-coding-agent docs/json.md):
 *
 *   { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }
 *   { type: "message_update", assistantMessageEvent: { type: "reasoning_delta", delta } }
 *   { type: "tool_execution_start", toolCallId, toolName, args }
 *   { type: "tool_execution_update", toolCallId, partialResult }
 *   { type: "tool_execution_end", toolCallId, result, isError }
 *   { type: "queue_update" | "compaction_*" | "auto_retry_*" }
 *
 * Translation rules:
 *
 *   message_update + text_delta     → { type: "text", part: { type, text, id: messageId }, sessionID }
 *   message_update + reasoning_delta → { type: "reasoning", part: { type, text, id: messageId }, sessionID }
 *   tool_execution_start            → { type: "tool", part: { type: "tool",
 *                                       id: toolCallId, tool: toolName,
 *                                       state: { status: "running", input: args } }, sessionID }
 *   tool_execution_update           → { type: "tool", part: { ... state.status: "running",
 *                                       state.partial: partialResult }, sessionID }
 *   tool_execution_end              → { type: "tool", part: { ... state.status: isError ? "error" : "completed",
 *                                       state.output: result }, sessionID }
 *   auto_retry_*                    → { type: "step_start"|"step_finish", part: { reason: "retry" }, sessionID }
 *   compaction_*                    → dropped (UI-irrelevant)
 *   queue_update                    → dropped
 *
 * Unknown event shapes are dropped. Malformed JSON lines are reported via
 * the `onParseError` callback (used for stderr logging) and otherwise
 * skipped — one bad frame must not kill the stream.
 */

export interface PiJsonEvent {
  type: string;
  [key: string]: unknown;
}

export interface TranslateContext {
  sessionID: string;
  /**
   * Stable id for the in-flight assistant message. Pi text deltas don't
   * carry a message id; we synthesize one per turn so the UI can collapse
   * all text deltas for the turn into a single bubble.
   */
  assistantMessageId: string;
  /**
   * Annotation surfaced on every event when set: `{providerID, modelID}`
   * — used by the chat log so "what model produced this step?" is
   * answerable from the log alone, mirroring the legacy runtime behavior.
   */
  model?: { providerID: string; modelID: string; agent?: string };
}

export interface TerminalAssistantMessage {
  stopReason: "stop" | "length" | "error" | "aborted";
  exitCode: 0 | 1;
  text: string;
  errorMessage?: string;
  model?: { providerID: string; modelID: string };
}

export function modelSelectionFromEvent(evt: PiJsonEvent): { providerID: string; modelID: string } | null {
  if (!evt || typeof evt !== "object") return null;
  if (evt.type === "model_select") {
    const model = (evt as { model?: unknown }).model;
    if (!model || typeof model !== "object") return null;
    const m = model as { provider?: unknown; id?: unknown; modelId?: unknown };
    const providerID = typeof m.provider === "string" ? m.provider : undefined;
    const modelID = typeof m.id === "string"
      ? m.id
      : typeof m.modelId === "string"
        ? m.modelId
        : undefined;
    return providerID && modelID ? { providerID, modelID } : null;
  }
  if (evt.type === "model_change") {
    const e = evt as { provider?: unknown; modelId?: unknown; model?: unknown };
    const providerID = typeof e.provider === "string" ? e.provider : undefined;
    const modelID = typeof e.modelId === "string"
      ? e.modelId
      : typeof e.model === "string"
        ? e.model
        : undefined;
    return providerID && modelID ? { providerID, modelID } : null;
  }
  return null;
}

/**
 * Maps one pi JSON event to one (or zero) run-format JSON line(s). Returns
 * the JSON string(s) ready to be emitted via `onLog({kind: "event"})`.
 */
export function translatePiEvent(
  evt: PiJsonEvent,
  ctx: TranslateContext,
): string[] {
  if (!evt || typeof evt !== "object" || typeof evt.type !== "string") return [];

  switch (evt.type) {
    case "message_update":
      return translateMessageUpdate(evt, ctx);
    case "tool_execution_start":
      return translateToolStart(evt, ctx);
    case "tool_execution_update":
      return translateToolUpdate(evt, ctx);
    case "tool_execution_end":
      return translateToolEnd(evt, ctx);
    case "auto_retry_start":
      return [
        runFormatLine("step_start", { type: "step_start", reason: "retry" }, ctx),
      ];
    case "auto_retry_end":
      return [
        runFormatLine(
          "step_finish",
          { type: "step_finish", reason: (evt as { success?: boolean }).success ? "stop" : "error" },
          ctx,
        ),
      ];
    case "compaction_start":
    case "compaction_end":
    case "queue_update":
      return [];
    default:
      return [];
  }
}

export function terminalAssistantMessage(evt: PiJsonEvent): TerminalAssistantMessage | null {
  const message = assistantMessageFromEvent(evt);
  if (!message) return null;
  const stopReason = message.stopReason;
  if (
    stopReason !== "stop" &&
    stopReason !== "length" &&
    stopReason !== "error" &&
    stopReason !== "aborted"
  ) {
    return null;
  }
  const text = assistantText(message);
  const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
  const providerID = typeof message.provider === "string" ? message.provider : undefined;
  const modelID = typeof message.model === "string" ? message.model : undefined;
  return {
    stopReason,
    exitCode: stopReason === "error" || stopReason === "aborted" ? 1 : 0,
    text,
    ...(errorMessage ? { errorMessage } : {}),
    ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
  };
}

export function translateTerminalAssistantText(evt: PiJsonEvent, ctx: TranslateContext): string[] {
  const terminal = terminalAssistantMessage(evt);
  if (!terminal?.text) return [];
  return [
    runFormatLine(
      "text",
      { type: "text", text: terminal.text, id: ctx.assistantMessageId, messageID: ctx.assistantMessageId },
      ctx,
    ),
  ];
}

function assistantMessageFromEvent(evt: PiJsonEvent): {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  provider?: unknown;
  model?: unknown;
} | null {
  if (evt.type !== "message_end" && evt.type !== "message") return null;
  const message = (evt as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const maybe = message as {
    role?: unknown;
    content?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    provider?: unknown;
    model?: unknown;
  };
  return maybe.role === "assistant" ? maybe : null;
}

function assistantText(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as { type?: unknown; text?: unknown };
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function translateMessageUpdate(evt: PiJsonEvent, ctx: TranslateContext): string[] {
  const inner = (evt as { assistantMessageEvent?: { type?: unknown; delta?: unknown } })
    .assistantMessageEvent;
  if (!inner || typeof inner !== "object") return [];
  const subType = inner.type;
  const delta = typeof inner.delta === "string" ? inner.delta : "";
  if (!delta) return [];
  if (subType === "text_delta") {
    return [
      runFormatLine(
        "text",
        { type: "text", text: delta, id: ctx.assistantMessageId, messageID: ctx.assistantMessageId },
        ctx,
      ),
    ];
  }
  if (subType === "reasoning_delta") {
    return [
      runFormatLine(
        "reasoning",
        { type: "reasoning", text: delta, id: `${ctx.assistantMessageId}_reasoning`, messageID: ctx.assistantMessageId },
        ctx,
      ),
    ];
  }
  return [];
}

function translateToolStart(evt: PiJsonEvent, ctx: TranslateContext): string[] {
  const e = evt as { toolCallId?: unknown; toolName?: unknown; args?: unknown };
  const id = typeof e.toolCallId === "string" ? e.toolCallId : "";
  const name = typeof e.toolName === "string" ? e.toolName : "";
  if (!id || !name) return [];
  return [
    runFormatLine(
      "tool",
      {
        type: "tool",
        id,
        tool: name,
        name,
        state: { status: "running", input: e.args ?? null },
      },
      ctx,
    ),
  ];
}

function translateToolUpdate(evt: PiJsonEvent, ctx: TranslateContext): string[] {
  const e = evt as { toolCallId?: unknown; toolName?: unknown; partialResult?: unknown };
  const id = typeof e.toolCallId === "string" ? e.toolCallId : "";
  if (!id) return [];
  return [
    runFormatLine(
      "tool",
      {
        type: "tool",
        id,
        tool: typeof e.toolName === "string" ? e.toolName : undefined,
        state: { status: "running", partial: e.partialResult ?? null },
      },
      ctx,
    ),
  ];
}

function translateToolEnd(evt: PiJsonEvent, ctx: TranslateContext): string[] {
  const e = evt as { toolCallId?: unknown; toolName?: unknown; result?: unknown; isError?: unknown };
  const id = typeof e.toolCallId === "string" ? e.toolCallId : "";
  if (!id) return [];
  const isError = e.isError === true;
  return [
    runFormatLine(
      "tool",
      {
        type: "tool",
        id,
        tool: typeof e.toolName === "string" ? e.toolName : undefined,
        name: typeof e.toolName === "string" ? e.toolName : undefined,
        state: {
          status: isError ? "error" : "completed",
          output: e.result ?? null,
          ...(isError ? { error: stringifyError(e.result) } : {}),
        },
      },
      ctx,
    ),
  ];
}

function stringifyError(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function runFormatLine(
  type: string,
  part: Record<string, unknown>,
  ctx: TranslateContext,
): string {
  const event: Record<string, unknown> = { type, part, sessionID: ctx.sessionID };
  if (ctx.model) event.model = ctx.model;
  return JSON.stringify(event);
}

/**
 * Parses pi's stdout byte stream as newline-delimited JSON. Each non-empty
 * line is one event; malformed lines are surfaced via `onParseError` and
 * skipped so a single bad frame doesn't kill the stream.
 *
 * Pi prints one JSON object per line on stdout in `--mode json`; stderr
 * carries unstructured log lines (read separately by the caller).
 */
export async function* readPiJsonEvents(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  opts: { onParseError?: (raw: string, err: unknown) => void } = {},
): AsyncIterable<PiJsonEvent> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const iter = "getReader" in (body as ReadableStream<Uint8Array>)
    ? readableStreamToAsyncIterable(body as ReadableStream<Uint8Array>)
    : (body as AsyncIterable<Uint8Array>);

  for await (const chunk of iter) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      const evt = parseJsonLine(raw, opts.onParseError);
      if (evt) yield evt;
    }
  }
  const trailing = buffer.trim();
  if (trailing) {
    const evt = parseJsonLine(trailing, opts.onParseError);
    if (evt) yield evt;
  }
}

async function* readableStreamToAsyncIterable(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock?.();
  }
}

function parseJsonLine(
  raw: string,
  onParseError?: (raw: string, err: unknown) => void,
): PiJsonEvent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
      return parsed as PiJsonEvent;
    }
    return null;
  } catch (err) {
    onParseError?.(raw, err);
    return null;
  }
}
