import { type IncomingMessage, type ServerResponse } from "node:http";
import { withModule } from "@roomy-ai/shared/logger";
import { parseBody, sendJson } from "../http/io.js";

const log = withModule("client.perf");

/**
 * Cap how much a single misbehaving client can dump per request. Long-task
 * batches in the wild stay well under 50 entries even on slow machines, so
 * 200 leaves headroom for bursts without giving an attacker a cheap way to
 * fill the log pipeline.
 */
const MAX_ENTRIES_PER_REQUEST = 200;
const MAX_STRING_LEN = 200;

interface ClientPerfEntry {
  /** Long-task duration in ms (PerformanceEntry.duration). */
  duration: number;
  /** When the task started, ms since the page nav (PerformanceEntry.startTime). */
  startTime: number;
  /** PerformanceEntry.name — usually "self" or an attribution string. */
  name?: string;
  /** Chat the user was viewing when the long task fired, if any. */
  chatId?: string;
  /** Whether an agent turn was streaming in the viewed chat. */
  streaming?: boolean;
  /** Pathname + search at the time of the event. Bounded by MAX_STRING_LEN. */
  url?: string;
  /** Best-effort JS heap snapshot at flush time, when supported. */
  heapUsedMb?: number;
}

function clampString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > MAX_STRING_LEN ? value.slice(0, MAX_STRING_LEN) : value;
}

function clampNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  // PerformanceEntry timestamps are milliseconds since nav; anything beyond
  // a day suggests a malformed/forged payload. Drop it instead of logging.
  if (value < 0 || value > 86_400_000) return undefined;
  return value;
}

function normalizeEntry(raw: unknown): ClientPerfEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const duration = clampNumber(obj.duration);
  const startTime = clampNumber(obj.startTime);
  if (duration === undefined || startTime === undefined) return null;
  const entry: ClientPerfEntry = { duration, startTime };
  const name = clampString(obj.name);
  if (name) entry.name = name;
  const chatId = clampString(obj.chatId);
  if (chatId) entry.chatId = chatId;
  if (typeof obj.streaming === "boolean") entry.streaming = obj.streaming;
  const url = clampString(obj.url);
  if (url) entry.url = url;
  const heapUsedMb = clampNumber(obj.heapUsedMb);
  if (heapUsedMb !== undefined) entry.heapUsedMb = heapUsedMb;
  return entry;
}

/**
 * Receive a batch of client-side long-task observations. Each entry lands
 * in the structured log so prod regressions ("typing got slow this week")
 * can be diagnosed without re-instrumenting from a user bug report.
 *
 * Returns the count accepted so the client can verify it isn't getting
 * silently dropped by request size limits.
 */
export async function recordClientPerf(
  req: IncomingMessage,
  res: ServerResponse,
  userId: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await parseBody(req);
  } catch {
    sendJson(res, 400, { code: "BAD_REQUEST", message: "Invalid JSON body" });
    return;
  }

  if (!body || typeof body !== "object" || !Array.isArray((body as { entries?: unknown }).entries)) {
    sendJson(res, 400, { code: "BAD_REQUEST", message: "Missing 'entries' array" });
    return;
  }

  const rawEntries = (body as { entries: unknown[] }).entries.slice(0, MAX_ENTRIES_PER_REQUEST);
  const entries = rawEntries
    .map(normalizeEntry)
    .filter((entry): entry is ClientPerfEntry => entry !== null);

  if (entries.length === 0) {
    sendJson(res, 200, { accepted: 0 });
    return;
  }

  for (const entry of entries) {
    log.warn(
      {
        user_id: userId,
        duration_ms: Math.round(entry.duration),
        start_time_ms: Math.round(entry.startTime),
        long_task_name: entry.name,
        chat_id: entry.chatId,
        streaming: entry.streaming,
        url: entry.url,
        heap_used_mb: entry.heapUsedMb,
      },
      "long task",
    );
  }
  sendJson(res, 200, { accepted: entries.length });
}
