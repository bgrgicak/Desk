import { MessageSchema, type Message } from "@roomy-ai/shared";
import type { Pool } from "../pool.js";
import {
  eventHasUserVisibleDiagnostic,
  firstDiagnosticString,
  isUserVisibleDiagnosticLine,
} from "./messages.sql-helpers.js";

export type MessageListView = "full" | "compact" | "timeline";

export interface PaginatedMessages {
  items: Message[];
  nextCursor?: string;
  /** Cursor pointing backwards (towards older messages). Present when
   *  `before` was used and there are still older messages. */
  prevCursor?: string;
}

export const MAX_REQUEUE_ATTEMPTS = 5;

export function bumpIsoAbove(baseIso: string): string {
  const ms = Date.parse(baseIso);
  if (!Number.isFinite(ms)) return baseIso;
  return new Date(ms + 1).toISOString();
}

export function newestIso(values: Array<string | null | undefined>): string | null {
  let newest: string | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) continue;
    if (ms > newestMs) {
      newest = value;
      newestMs = ms;
    }
  }
  return newest;
}

export const FULL_MESSAGE_SELECT = `
  id,
  chat_id,
  role,
  content,
  created_at,
  updated_at,
  execute_at,
  cron,
  state,
  parent_id,
  agent_id,
  started_at,
  ended_at,
  model,
  attachments,
  kind,
  title,
  thread_chat_id
`;

export const FULL_MESSAGE_SELECT_M = `
  m.id,
  m.chat_id,
  m.role,
  m.content,
  m.created_at,
  m.updated_at,
  m.execute_at,
  m.cron,
  m.state,
  m.parent_id,
  m.agent_id,
  m.started_at,
  m.ended_at,
  m.model,
  m.attachments,
  m.kind,
  m.title,
  m.thread_chat_id
`;

const CONTENT_TYPE_SQL = "json_extract(content, '$.type')";

// Normal chat rendering does not need summaries or scheduler-only request rows.
// Keep rows that can render in the stream, agent_turn rows that drive
// typing/error state, and compact tool/event marker rows so historical
// tool-only turns can still show the completion fallback without shipping the
// heavy tool inputs/results/logs.
export function timelineFilterSql(): { sql: string; params: unknown[] } {
  return {
    sql: `
      AND (
        ${CONTENT_TYPE_SQL} IN ('text', 'artifactRef', 'agent_turn', 'toolCall', 'toolResult', 'events')
      )
    `,
    params: [],
  };
}

export async function timelineWhereClause(
  _db: Pool,
  chatId: string,
  view: MessageListView,
): Promise<{ sql: string; params: unknown[] }> {
  void chatId;
  if (view !== "timeline") return { sql: "", params: [] };
  return timelineFilterSql();
}

// SQLite stores JSON columns as TEXT; parse at the boundary. Postgres
// JSONB used to do this for us automatically.
function parseJson<T>(v: unknown): T | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return JSON.parse(v) as T;
  return v as T;
}

export function rowToMessage(row: Record<string, unknown>): Message {
  return MessageSchema.parse({
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    content: parseJson(row.content),
    createdAt: row.created_at as string,
    attachments: parseJson(row.attachments),
    model: row.model ?? undefined,
    executeAt: row.execute_at ? row.execute_at as string : undefined,
    cron: row.cron ?? undefined,
    state: row.state ?? undefined,
    parentId: row.parent_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    startedAt: row.started_at ? row.started_at as string : undefined,
    endedAt: row.ended_at ? row.ended_at as string : undefined,
    updatedAt: row.updated_at ? row.updated_at as string : undefined,
    kind: row.kind ?? "chat",
    title: row.title ?? null,
    threadChatId: row.thread_chat_id ?? undefined,
  });
}

function compactContent(content: Message["content"]): Message["content"] {
  switch (content.type) {
    case "events": {
      // Reasoning and text parts can share a `part.id` when the agent emits
      // both streams for the same pi event. Suppress the text twin so
      // the compact log doesn't duplicate the same content twice.
      const reasoningPartIds = new Set<string>();
      for (const entry of content.log) {
        if (entry.kind !== "event" || entry.event.type !== "reasoning") continue;
        const id = entry.event.part?.id;
        if (typeof id === "string") reasoningPartIds.add(id);
      }
      const log: typeof content.log = [];
      let sawStructuredEvent = false;
      for (const entry of content.log) {
        if (entry.kind === "event") {
          sawStructuredEvent = true;
          if (entry.event.type === "text") {
            const partId = entry.event.part?.id;
            if (typeof partId === "string" && reasoningPartIds.has(partId)) continue;
            const text = entry.event.part?.text;
            if (typeof text === "string") {
              log.push({
                kind: "event",
                event: { type: "text", part: { text } },
              });
            }
          } else if (eventHasUserVisibleDiagnostic(entry.event)) {
            log.push(entry);
          }
        } else if (entry.kind === "unparsed") {
          if (!sawStructuredEvent || isUserVisibleDiagnosticLine(entry.line)) log.push(entry);
        } else if (entry.kind === "stderr") {
          if (isUserVisibleDiagnosticLine(entry.line)) log.push(entry);
        }
      }
      return { type: "events", log };
    }
    case "toolCall":
      return { type: "toolCall", toolName: content.toolName, args: {} };
    case "toolResult":
      return { type: "toolResult", toolName: content.toolName, result: firstDiagnosticString(content.result) ?? null };
    case "summary":
      return { type: "summary", body: "" };
    default:
      return content;
  }
}

export function rowToListedMessage(row: Record<string, unknown>, view: MessageListView): Message {
  const message = rowToMessage(row);
  if (view === "full") return message;
  return { ...message, content: compactContent(message.content) };
}
