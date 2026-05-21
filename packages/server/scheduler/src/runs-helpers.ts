import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Cron } from "croner";
import {
  AgentEventSchema,
  type AgentEvent,
  type AgentLogEntry,
  type Message,
} from "@agent-desk/shared";

/**
 * Pure helpers extracted from runs.ts.  Anything in this file must NOT
 * close over scheduler state (pool, emit, modelContextCache, etc.) — it
 * runs as a side-effect-free function so the same logic can be unit-
 * tested without spinning up a full run manager.
 */

export interface SummaryModelTokenLimits {
  contextWindow: number;
  inputLimit?: number;
  outputLimit?: number;
}

export const CHAT_SUMMARY_PROMPT = [
  "Refresh this chat's running summary.",
  "Return only the final markdown body; do not create files, write artifacts, or attach artifacts.",
  "Use the chat-summary format described in the agent instructions.",
].join("\n");

// Maximum UTF-8 bytes the transcript context may occupy before being
// trimmed. The full prompt (context + task) must fit inside the
// container's ARG_MAX (2 097 152 bytes on Linux). We reserve ~500 KB for
// the task text, wrapper headers, and other env vars, leaving 1.5 MB for
// the context. Oldest entries are dropped first so the most recent
// messages are always preserved.
export const MAX_CONTEXT_BYTES = 1_500_000;

export function isNonEmpty(v: string | undefined): boolean {
  return typeof v === "string" && v.length > 0;
}

/**
 * Free `opencode/big-pickle` is the unauthenticated default. Every run
 * path falls back to it when the requested provider has no available
 * auth — keeping reflection / chat / summary alive instead of leaving a
 * run in a broken "no auth at all" state. Lives in helpers (not runs.ts)
 * so reflection can use the same resolver without creating a runs ↔
 * reflection import cycle.
 */
export const FALLBACK_MODEL = "opencode/big-pickle";

export type ModelResolutionReason =
  | null
  | "codex-oauth"
  | "codex-fallback-api-key"
  | "no-auth-fallback";

/**
 * Pick the model that should actually run, and the provider key map to
 * forward into the daemon.
 *
 *  1. Codex translation: `codex/X` is a Desk-only relabel — opencode-
 *     serve only knows the `openai` provider. With Codex OAuth available
 *     we route through it AND strip `OPENAI_API_KEY` so opencode picks
 *     the OAuth path. When Codex is disabled but `OPENAI_API_KEY` is
 *     present, we still unwrap the prefix and let the API key handle it.
 *  2. Hard fallback: when the requested model's provider has no auth at
 *     all, substitute `FALLBACK_MODEL`. The run keeps going on the free
 *     `opencode/*` model rather than dying with a
 *     `ProviderModelNotFoundError` or silently riding a stale auth blob
 *     the daemon cached from a previous spawn.
 *  3. No change for free models: `opencode/*` always runs as-is.
 *
 * Callers should forward `runtimeModel` to BOTH the agent file (so the
 * daemon's startup cache picks the fallback up) AND the driver's
 * per-message `providerID/modelID`, and forward `providerKeys` into the
 * sandbox env. The daemon ignores per-message overrides for agent-bound
 * sessions, so feeding the resolved model into the agent file is what
 * actually makes the daemon use it.
 */
export function resolveModelForRun(
  model: string,
  providerKeys: Record<string, string>,
  extraEnv?: Record<string, string>,
): {
  runtimeModel: string;
  providerKeys: Record<string, string>;
  reason: ModelResolutionReason;
} {
  const hasOpenAiKey = isNonEmpty(providerKeys.OPENAI_API_KEY);
  const hasAnthropicKey = isNonEmpty(providerKeys.ANTHROPIC_API_KEY);
  const oauthAvailable = isNonEmpty(extraEnv?.OPENCODE_AUTH_CONTENT);

  if (model.startsWith("codex/")) {
    const bare = `openai/${model.slice("codex/".length)}`;
    if (oauthAvailable) {
      const { OPENAI_API_KEY: _strip, ...withoutOpenAiApiKey } = providerKeys;
      return { runtimeModel: bare, providerKeys: withoutOpenAiApiKey, reason: "codex-oauth" };
    }
    if (hasOpenAiKey) {
      return { runtimeModel: bare, providerKeys, reason: "codex-fallback-api-key" };
    }
    return { runtimeModel: FALLBACK_MODEL, providerKeys, reason: "no-auth-fallback" };
  }

  if (model.startsWith("openai/")) {
    if (hasOpenAiKey || oauthAvailable) return { runtimeModel: model, providerKeys, reason: null };
    return { runtimeModel: FALLBACK_MODEL, providerKeys, reason: "no-auth-fallback" };
  }

  if (model.startsWith("anthropic/")) {
    if (hasAnthropicKey) return { runtimeModel: model, providerKeys, reason: null };
    return { runtimeModel: FALLBACK_MODEL, providerKeys, reason: "no-auth-fallback" };
  }

  return { runtimeModel: model, providerKeys, reason: null };
}

export function computeNextRun(cronExpr: string): string {
  const next = new Cron(cronExpr).nextRun();
  if (!next) throw new Error(`cron expression "${cronExpr}" has no future occurrences`);
  return next.toISOString();
}

export function eventPartId(event: AgentEvent): string | undefined {
  const id = event.part?.id;
  return typeof id === "string" ? id : undefined;
}

export function reasoningPartIds(entries: AgentLogEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "event" || e.event.type !== "reasoning") continue;
    const id = eventPartId(e.event);
    if (id) ids.add(id);
  }
  return ids;
}

/** Concatenates text from `text`-type agent events; falls back to any
 * `unparsed` lines so plain-string test drivers still produce output. */
export function deriveTextFromLog(entries: AgentLogEntry[]): string {
  const parts: string[] = [];
  let sawEvent = false;
  const hiddenReasoningTextIds = reasoningPartIds(entries);
  for (const e of entries) {
    if (e.kind === "event") {
      sawEvent = true;
      if (e.event.type === "text") {
        const id = eventPartId(e.event);
        if (id && hiddenReasoningTextIds.has(id)) continue;
        const t = e.event.part?.text;
        if (typeof t === "string") parts.push(t);
      }
    }
  }
  if (sawEvent) return parts.join("").trim();
  // No structured events — fall back to unparsed stdout lines.
  return entries
    .filter((e) => e.kind === "unparsed")
    .map((e) => (e as { line: string }).line)
    .join("\n")
    .trim();
}

/**
 * Summaries should be a clean final markdown body. If the model used tools, keep
 * the final text part instead of concatenating planning chatter with the final
 * answer. Current opencode streams that final part as many text deltas, so
 * reconstruct chunks that share a part/message id.
 */
export function deriveSummaryTextFromLog(entries: AgentLogEntry[]): string {
  let sawEvent = false;
  let currentPartKey: string | null = null;
  let currentPartText = "";
  const hiddenReasoningTextIds = reasoningPartIds(entries);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind !== "event") continue;
    sawEvent = true;
    if (e.event.type === "text") {
      const id = eventPartId(e.event);
      if (id && hiddenReasoningTextIds.has(id)) continue;
      const t = e.event.part?.text;
      if (typeof t !== "string" || !t.trim()) continue;
      const messageId = typeof e.event.part?.messageID === "string" ? e.event.part.messageID : undefined;
      // Deltas from the same assistant text part carry the same part id. Older
      // run-format fixtures sometimes omit ids, so make those individual parts
      // to preserve the old "last text event wins" behavior after tool use.
      const partKey = id ?? messageId ?? `event:${i}`;
      if (partKey !== currentPartKey) {
        currentPartKey = partKey;
        currentPartText = t;
      } else if (t.startsWith(currentPartText)) {
        // A consolidated `message.part.updated` snapshot for a part may arrive
        // after deltas. Replace accumulated chunks with the full snapshot rather
        // than duplicating the response.
        currentPartText = t;
      } else {
        currentPartText += t;
      }
    }
  }
  if (currentPartText) return currentPartText.trim();
  if (sawEvent) return "";
  return entries
    .filter((e) => e.kind === "unparsed")
    .map((e) => (e as { line: string }).line)
    .join("\n")
    .trim();
}

export function messageTextForPrompt(message: Message): string | null {
  const content = message.content;
  switch (content.type) {
    case "text":
      return content.text;
    case "artifactRef":
      return `Attached artifact: ${content.name ?? content.path} (${content.path})`;
    case "summary":
      return content.body;
    case "events":
      return deriveTextFromLog(content.log) || null;
    case "feedback": {
      const rating = content.rating === "down" ? "👎 not helpful" : "👍 helpful";
      return `User reacted ${rating} on a prior agent reply (message ${content.targetMessageId}).`;
    }
    default:
      return null;
  }
}

export function formatMessageForPrompt(message: Message): { role: string; text: string } | null {
  const text = messageTextForPrompt(message);
  const attachmentText = (message.attachments ?? [])
    .map((attachment) => `${attachment.name ?? path.basename(attachment.path)} (${attachment.path})`)
    .join(", ");
  const body = [text, attachmentText ? `Attachments: ${attachmentText}` : ""]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n");
  if (!body.trim()) return null;
  const role = message.content.type === "summary"
    ? "Summary"
    : message.role === "user"
      ? "User"
      : message.role === "agent"
        ? "Agent"
        : "System";
  return {
    role,
    text: body.trim(),
  };
}

export function shouldIncludeInPromptContext(message: Message, taskRunParentIds: Set<string> = new Set()): boolean {
  const type = message.content.type;
  if (type === "agent_turn" || type === "summary_request" || type === "reflection_request") return false;
  // Scheduled task definitions and their run children are operational records,
  // not conversational turns. If included as normal Agent/User transcript text,
  // a later agent run can misread an old task as a fresh instruction and
  // schedule it again.
  if (message.kind === "task" || message.kind === "task_run") return false;
  // Task run output is stored as a normal agent chat child under the task_run
  // row, so exclude those children too.
  if (message.parentId && taskRunParentIds.has(message.parentId)) return false;
  if (message.state === "pending" || message.state === "running") return false;
  // Feedback rows are `role: 'system'` 👍/👎 reactions. Surface them in
  // the transcript context so an agent picking up the chat — including
  // the daily workspace reflection — can read the user's verdict on
  // earlier replies.
  if (type === "feedback") return true;
  return message.role === "user" || message.role === "agent" || type === "summary";
}

export function outputContentTypeFor(msg: Message): "summary" | "text" {
  if (msg.kind === "summary") return "summary";
  const c = msg.content as { type?: string };
  return c?.type === "summary_request" ? "summary" : "text";
}

export function buildOutputContent(
  kind: "summary" | "text",
  entries: AgentLogEntry[],
): Message["content"] | null {
  if (kind === "summary") {
    const body = deriveSummaryTextFromLog(entries);
    if (!body) return null;
    return { type: "summary", body };
  }
  if (entries.length === 0) return null;
  return { type: "events", log: entries };
}

export function errorLogLines(err: unknown): string[] {
  const message = err instanceof Error ? err.message : String(err);
  return [
    "Agent run failed before it could complete.",
    message,
  ].filter((line) => line.trim().length > 0);
}

export function isUnscheduledTask(task: Message): boolean {
  // Unscheduled tasks are kanban cards first and execution prompts second.
  // A completed agent run is history on a task_run child; it must not
  // silently move the parent card out of Todo/Active regardless of who
  // authored the parent task.
  return task.kind === "task" && !task.executeAt && !task.cron;
}

export function summarizeMessagePreview(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 96 ? `${normalized.slice(0, 95).trimEnd()}…` : normalized;
}

export function envPositiveInt(name: string): number | null {
  const fromEnv = Number.parseInt(
    process.env[name] ?? "",
    10,
  );
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : null;
}

export function summaryTriggerFraction(): number {
  const fromEnv = Number.parseFloat(process.env.DESK_SUMMARY_TRIGGER_FRACTION ?? "");
  return Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 1 ? fromEnv : 0.15;
}

export function summaryTriggerBudget(limits: SummaryModelTokenLimits): number {
  const explicit = envPositiveInt("DESK_SUMMARY_TRIGGER_TOKENS");
  if (explicit !== null) return explicit;

  const min = envPositiveInt("DESK_SUMMARY_TRIGGER_MIN_TOKENS") ?? 6_000;
  const max = envPositiveInt("DESK_SUMMARY_TRIGGER_MAX_TOKENS") ?? 12_000;
  const effectiveInputWindow = limits.inputLimit ?? limits.contextWindow;
  const fractional = Math.floor(effectiveInputWindow * summaryTriggerFraction());
  const safeUpperBound = Math.floor(effectiveInputWindow * 0.6);
  return Math.max(1, Math.min(Math.max(fractional, min), max, safeUpperBound));
}

export function normalizeModelLimits(value: number | SummaryModelTokenLimits | null): SummaryModelTokenLimits | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? { contextWindow: value } : null;
  }
  if (value === null) return null;
  if (!Number.isFinite(value.contextWindow) || value.contextWindow <= 0) return null;
  return {
    contextWindow: value.contextWindow,
    ...(value.inputLimit !== undefined && Number.isFinite(value.inputLimit) && value.inputLimit > 0 ? { inputLimit: value.inputLimit } : {}),
    ...(value.outputLimit !== undefined && Number.isFinite(value.outputLimit) && value.outputLimit > 0 ? { outputLimit: value.outputLimit } : {}),
  };
}

export function modelLimitsFromRef(model: {
  id: string;
  provider: string;
  contextWindow?: number;
  inputLimit?: number;
  outputLimit?: number;
}): SummaryModelTokenLimits | null {
  return normalizeModelLimits({
    contextWindow: model.contextWindow ?? model.inputLimit ?? 0,
    ...(model.inputLimit !== undefined ? { inputLimit: model.inputLimit } : {}),
    ...(model.outputLimit !== undefined ? { outputLimit: model.outputLimit } : {}),
  });
}

// Convert the reflection journal into a brief task-run log entry. The prompt
// (`reflection-workspace.md`) is the source of truth for output shape — it
// asks the model for at most 3 plain bullets. We strip headings/leading
// bullet markers, drop blanks, and keep the first few lines verbatim so a
// bad model run is visible (and fixable in the prompt) instead of silently
// sanitised here.
export function reflectionOutcomeText(journal: string | null): string {
  if (journal === null) return "- No activity.";
  if (journal.trim().length === 0) return "- Empty reflection.";

  const bullets: string[] = [];
  for (const rawLine of journal.split(/\r?\n/)) {
    const line = rawLine
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*]\s+/, "")
      .trim();
    if (!line) continue;
    bullets.push(`- ${line}`);
    if (bullets.length >= 3) break;
  }
  return bullets.length > 0 ? bullets.join("\n") : "- Empty reflection.";
}

/**
 * Parses a per-message log file (`{kind}\t{payload}\n` per onLog call)
 * into the tagged AgentLogEntry stream used by `events`-content
 * messages. Each payload may itself contain embedded newlines (a single
 * stdout write can cover multiple JSON events), so we split inside
 * each payload before parsing.
 */
export async function readLogEntries(p: string): Promise<AgentLogEntry[]> {
  let buf: string;
  try {
    buf = await fsp.readFile(p, "utf8");
  } catch {
    return [];
  }
  const entries: AgentLogEntry[] = [];
  for (const rawLine of buf.split("\n")) {
    if (!rawLine) continue;
    const tab = rawLine.indexOf("\t");
    if (tab <= 0) continue;
    const kind = rawLine.slice(0, tab);
    const payload = rawLine.slice(tab + 1);
    for (const line of payload.split("\n")) {
      if (line === "") continue;
      if (kind === "stderr") {
        entries.push({ kind: "stderr", line });
        continue;
      }
      // stdout / event: attempt to parse as JSON and validate.
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        entries.push({ kind: "unparsed", line });
        continue;
      }
      const validated = AgentEventSchema.safeParse(parsed);
      if (validated.success) {
        entries.push({ kind: "event", event: validated.data });
      } else {
        entries.push({ kind: "unparsed", line });
      }
    }
  }
  return entries;
}
