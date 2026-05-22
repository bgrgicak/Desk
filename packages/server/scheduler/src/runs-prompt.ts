import { type Pool, queries } from "@roomy-ai/db";
import type { Message } from "@roomy-ai/shared";
import {
  CHAT_SUMMARY_PROMPT,
  formatMessageForPrompt,
  MAX_CONTEXT_BYTES,
  shouldIncludeInPromptContext,
} from "./runs-helpers.js";

/**
 * Builds the chat-transcript context block prepended to the agent prompt.
 * Lists every relevant message that should ride along (filtered by
 * `shouldIncludeInPromptContext`), trims oldest-first when the running
 * total exceeds `MAX_CONTEXT_BYTES`, and inserts a "omitted" marker so
 * the agent knows the transcript was clipped.
 *
 * `currentMessage` is the row about to be fired; it is intentionally
 * excluded so the agent doesn't see its own prompt twice. When the
 * current row is an `agent_turn` trigger, the optional
 * `currentUserMessageId` parameter excludes the corresponding user
 * message (the one whose body becomes the prompt itself).
 */
export async function buildChatTranscriptContext(
  pool: Pool,
  currentMessage: Message,
  currentUserMessageId?: string,
): Promise<string> {
  const items = await queries.messages.listAgentContextByChat(pool, currentMessage.chatId);
  const taskRunParentIds = new Set(items.filter((message) => message.kind === "task_run").map((message) => message.id));
  const entries = items
    .filter((message) => message.id !== currentMessage.id && message.id !== currentUserMessageId)
    .filter((message) => shouldIncludeInPromptContext(message, taskRunParentIds))
    .map(formatMessageForPrompt)
    .filter((entry): entry is { role: string; text: string } => entry !== null);

  // Trim from oldest → newest until the serialised context fits.
  const sep = "\n\n---\n\n";
  let bytes = 0;
  let trimFrom = 0; // first index to keep
  for (let i = entries.length - 1; i >= 0; i--) {
    const chunk = `${entries[i].role}:\n${entries[i].text}`;
    bytes += Buffer.byteLength(chunk, "utf8") + (i < entries.length - 1 ? Buffer.byteLength(sep, "utf8") : 0);
    if (bytes > MAX_CONTEXT_BYTES) {
      trimFrom = i + 1;
      break;
    }
  }
  const kept = trimFrom > 0 ? entries.slice(trimFrom) : entries;
  const parts = kept.map((entry) => `${entry.role}:\n${entry.text}`);
  if (trimFrom > 0) {
    parts.unshift(`System:\n[Earlier context omitted — transcript exceeded size limit. ${trimFrom} older message(s) not shown.]`);
  }
  return parts.join(sep);
}

export async function withChatTranscriptContext(
  pool: Pool,
  currentMessage: Message,
  prompt: string,
  currentUserMessageId?: string,
): Promise<string> {
  const context = await buildChatTranscriptContext(pool, currentMessage, currentUserMessageId);
  if (!context) return prompt;
  return [
    "Chat transcript context (oldest to newest; newest summary, if any, is the compaction boundary):",
    context,
    "",
    "Current task:",
    prompt,
  ].join("\n");
}

/**
 * Returns the prompt the agent will receive plus any workspace-relative
 * attachment paths to forward to pi via `--file`. We don't inline
 * paths into the prompt: pi surfaces the file content directly,
 * and the picker-side path may live anywhere in the workspace, not just
 * `~/.chats/.../attachments/`.
 */
export async function derivePromptInputs(
  pool: Pool,
  msg: Message,
): Promise<{ prompt: string; attachments?: string[] }> {
  // Self-firing kinds (task / summary) carry the prompt directly on the
  // message — no parent lookup needed.
  if (msg.kind === "summary") {
    return { prompt: await withChatTranscriptContext(pool, msg, CHAT_SUMMARY_PROMPT) };
  }
  if (msg.kind === "task") {
    const c = msg.content as { type?: string; text?: string };
    const text = c?.type === "text" && typeof c.text === "string" ? c.text : "";
    const refs = msg.attachments ?? [];
    const attachments = refs.length > 0 ? refs.map((a) => a.path) : undefined;
    return { prompt: await withChatTranscriptContext(pool, msg, text), attachments };
  }
  if (msg.content.type === "reflection_request") {
    return { prompt: "Run the daily workspace memory reflection." };
  }
  const c = msg.content as { type?: string; text?: string; body?: string; userMessageId?: string };
  if (c?.type === "text" && typeof c.text === "string") {
    return { prompt: await withChatTranscriptContext(pool, msg, c.text) };
  }
  if (c?.type === "summary_request") {
    return { prompt: await withChatTranscriptContext(pool, msg, CHAT_SUMMARY_PROMPT) };
  }
  if (c?.type === "agent_turn" && typeof c.userMessageId === "string") {
    const userMsg = await queries.messages.findById(pool, c.userMessageId);
    const inner = userMsg?.content as { type?: string; text?: string } | undefined;
    const text = inner?.type === "text" && typeof inner.text === "string" ? inner.text : "";
    const refs = userMsg?.attachments ?? [];
    const attachments = refs.length > 0 ? refs.map((a) => a.path) : undefined;
    return { prompt: await withChatTranscriptContext(pool, msg, text, c.userMessageId), attachments };
  }
  const fallback = JSON.stringify(msg.content);
  return { prompt: await withChatTranscriptContext(pool, msg, fallback) };
}
