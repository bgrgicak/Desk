import pg from "pg";
import { Readable } from "node:stream";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { queries } from "@desk/db";
import { generateId, NotFoundError, ValidationError, AttachmentRefSchema, type AttachmentRef, type Message, type WsEvent } from "@desk/shared";
import { z } from "zod";
import {
  chatAttachmentsDir,
  listNoteHistory,
  materializeNote,
  snapshotNote,
  trashChatDirectories,
  uploadArtifact,
  workspaceRootPath,
  type FileRef,
  type NoteVersion,
  type StorageContext,
} from "@desk/storage";

interface SchedulerCancelAdapter {
  removeAt: (id: string) => Promise<void>;
  removeCron: (id: string) => Promise<void>;
}

/**
 * Subset of the run manager the patch-message route needs to drive
 * scheduler-aware state transitions (pause / resume / cancel-in-place).
 * Kept as its own interface so chats.ts doesn't depend on the whole
 * scheduler package.
 */
export interface MessageLifecycleOps {
  pauseMessage(messageId: string): Promise<Message | null>;
  resumeMessage(messageId: string): Promise<Message | null>;
  cancelScheduledMessage(messageId: string): Promise<Message | null>;
}

/**
 * Cancels the at/cron entry a single message owned via `schedulerRef`.
 * Best-effort: a stale ref (already fired, already removed) is swallowed
 * so deletion isn't blocked on infra drift. Shared by per-message delete
 * and by the per-chat cascade.
 */
async function cancelSchedulerRef(
  msg: Message,
  adapter: SchedulerCancelAdapter | null,
): Promise<void> {
  const ref = msg.schedulerRef;
  if (!ref || !adapter) return;
  try {
    if (ref.kind === "at") await adapter.removeAt(ref.id);
    else if (ref.kind === "cron") await adapter.removeCron(ref.id);
  } catch {
    // Stale refs are OK.
  }
}

async function cancelSchedulerRefsForChat(
  pool: pg.Pool,
  chatId: string,
  adapter: SchedulerCancelAdapter | null,
): Promise<void> {
  if (!adapter) return;
  const { rows } = await pool.query(
    `SELECT id, scheduler_ref FROM messages
     WHERE chat_id = $1 AND scheduler_ref IS NOT NULL`,
    [chatId],
  );
  for (const row of rows) {
    const ref = row.scheduler_ref as { kind?: string; id?: string } | null;
    if (!ref || !ref.id) continue;
    try {
      if (ref.kind === "at") await adapter.removeAt(ref.id);
      else if (ref.kind === "cron") await adapter.removeCron(ref.id);
    } catch {
      // Stale refs are OK.
    }
  }
}

export async function listChats(pool: pg.Pool, workspaceId: string) {
  return queries.chats.listWithLatestMessage(pool, workspaceId);
}

export async function getChat(pool: pg.Pool, id: string) {
  const chat = await queries.chats.findById(pool, id);
  if (!chat) throw new NotFoundError(`Chat not found: ${id}`);
  return chat;
}

export async function createChat(
  pool: pg.Pool,
  data: { workspaceId: string; agentId: string; title: string; goal?: string },
) {
  return queries.chats.insert(pool, {
    id: generateId("chat"),
    ...data,
  });
}

export async function patchChat(
  pool: pg.Pool,
  id: string,
  data: { title?: string; goal?: string; agentId?: string },
) {
  const chat = await queries.chats.updateMeta(pool, id, data);
  if (!chat) throw new NotFoundError(`Chat not found: ${id}`);
  return chat;
}

export async function listMessages(
  pool: pg.Pool,
  chatId: string,
  opts?: { cursor?: string },
) {
  return queries.messages.listByChat(pool, chatId, opts);
}

/**
 * User sends a chat message. Inserts two rows:
 *   1. The user's message (role=user, immutable) — carries the text.
 *   2. A pending system trigger with `agent_turn` content that references
 *      the user message id. fireMessage resolves the referenced user
 *      message at fire time and uses its text as the prompt, so the
 *      payload is never duplicated.
 *
 * Callers (app.ts) get the trigger's id back to schedule the fire.
 */
const SendMessageSchema = z.object({
  content: z.string(),
  attachments: z.array(AttachmentRefSchema).optional(),
});

export async function sendMessage(
  pool: pg.Pool,
  chatId: string,
  rawData: unknown,
  emit: (event: WsEvent) => void,
): Promise<{ userMessage: Message; triggerId: string }> {
  const parsed = SendMessageSchema.safeParse(rawData);
  if (!parsed.success) {
    throw new ValidationError(`Invalid message body: ${parsed.error.message}`);
  }
  const data = parsed.data;

  const chat = await queries.chats.findById(pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);

  const attachments: AttachmentRef[] | undefined =
    data.attachments && data.attachments.length > 0 ? data.attachments : undefined;

  const userMessage = await queries.messages.insert(pool, {
    id: generateId("message"),
    chatId,
    role: "user",
    content: { type: "text", text: data.content },
    attachments,
  });

  emit({ type: "message.appended", payload: userMessage });

  const triggerId = generateId("message");
  await queries.messages.insert(pool, {
    id: triggerId,
    chatId,
    role: "system",
    content: { type: "agent_turn", userMessageId: userMessage.id },
    state: "pending",
    parentId: userMessage.id,
    agentId: chat.agentId,
  });

  return { userMessage, triggerId };
}

/**
 * PATCH a message. Supports editing content (e.g. user edits a note) and
 * lifecycle transitions: `cancelled` (stop & keep the row), `paused`
 * (stop firing without losing the schedule), `pending` (resume from
 * paused). Returns the updated row. Emits message.updated over WS.
 *
 * State transitions delegate to the run manager so the OS-level at/cron
 * entry is actually removed or re-installed; content-only patches (e.g.
 * user editing a note body) snapshot the prior note and take the plain
 * DB update path.
 */
export async function patchMessage(
  pool: pg.Pool,
  storage: StorageContext,
  chatId: string,
  messageId: string,
  data: { content?: unknown; state?: string; executeAt?: string | null; cron?: string | null },
  emit: (event: WsEvent) => void,
  lifecycleOps: MessageLifecycleOps | null = null,
): Promise<Message> {
  const current = await queries.messages.findById(pool, messageId);
  if (!current || current.chatId !== chatId) {
    throw new NotFoundError(`Message not found in chat: ${messageId}`);
  }
  if (data.state !== undefined && !["cancelled", "pending", "paused"].includes(data.state)) {
    throw new ValidationError(
      `state can only be patched to 'cancelled', 'paused', or 'pending' via this endpoint`,
    );
  }
  if (data.state === "pending" && current.state !== "paused") {
    throw new ValidationError(
      `state can only be patched to 'pending' from 'paused'`,
    );
  }
  if (data.state === "paused" && current.state !== "pending") {
    throw new ValidationError(
      `state can only be patched to 'paused' from 'pending'`,
    );
  }

  if (data.content !== undefined) {
    const prev = current.content as { type?: string; body?: string };
    if (prev?.type === "note" && typeof prev.body === "string") {
      await snapshotNote(storage.home, chatId, messageId, prev.body);
    }
    // Re-materialize the notes/{id}.md file when the body changes so the
    // agent's filesystem view stays in sync with the DB row.
    const next = data.content as { type?: string; body?: string };
    if (next?.type === "note" && typeof next.body === "string") {
      await materializeNote(storage.home, chatId, messageId, next.body).catch(() => { /* best-effort */ });
    }
  }

  // Lifecycle transitions route through the scheduler so OS-level at/cron
  // entries are added/removed in sync with the DB state. A state patch
  // with no other fields is delegated entirely; a combined content+state
  // patch first writes content, then transitions.
  if (data.state && lifecycleOps) {
    if (data.content !== undefined) {
      await queries.messages.updateMessage(pool, messageId, { content: data.content });
    }
    let updated: Message | null = null;
    if (data.state === "paused") updated = await lifecycleOps.pauseMessage(messageId);
    else if (data.state === "pending") updated = await lifecycleOps.resumeMessage(messageId);
    else if (data.state === "cancelled") updated = await lifecycleOps.cancelScheduledMessage(messageId);
    if (!updated) throw new NotFoundError(`Message not found: ${messageId}`);
    return updated;
  }

  const updated = await queries.messages.updateMessage(pool, messageId, data);
  if (!updated) throw new NotFoundError(`Message not found: ${messageId}`);
  emit({ type: "message.updated", payload: updated });
  return updated;
}

/**
 * Returns every archived version of the supplied note-content message,
 * newest first. Returns an empty list if no snapshots exist yet.
 */
export async function getNoteHistory(
  storage: StorageContext,
  chatId: string,
  messageId: string,
): Promise<{ versions: NoteVersion[] }> {
  const versions = await listNoteHistory(storage.home, chatId, messageId);
  return { versions };
}

/**
 * Deletes a message. Cancels any at/cron scheduler entry this message
 * owned via scheduler_ref. Idempotent — deleting an already-gone
 * message returns 404; deleting with no scheduler_ref just removes
 * the row.
 */
export async function deleteMessage(
  pool: pg.Pool,
  storage: StorageContext,
  chatId: string,
  messageId: string,
  adapter: SchedulerCancelAdapter | null,
): Promise<void> {
  const msg = await queries.messages.findById(pool, messageId);
  if (!msg || msg.chatId !== chatId) {
    throw new NotFoundError(`Message not found in chat: ${messageId}`);
  }

  await cancelSchedulerRef(msg, adapter);

  await pool.query("DELETE FROM messages WHERE id = $1", [messageId]);

  // Move log file to trash if present.
  const logPath = path.join(
    storage.home,
    "Desk",
    "workspaces",
    "desk",
    ".chats",
    chatId,
    "logs",
    `${messageId}.log`,
  );
  await fs.access(logPath).then(async () => {
    const trashDir = path.join(storage.home, "Desk", ".trash");
    await fs.mkdir(trashDir, { recursive: true });
    await fs.rename(logPath, path.join(trashDir, `${Date.now()}-${messageId}.log`));
  }).catch(() => { /* no log file, fine */ });
}

/**
 * Tails the log file for a running (or completed) message. Returns the
 * body content stripped of kind prefixes, as a plain-text stream.
 */
export async function getMessageLogs(
  storage: StorageContext,
  chatId: string,
  messageId: string,
): Promise<{ stream: NodeJS.ReadableStream; contentType: string }> {
  const logPath = path.join(
    storage.home,
    "Desk",
    "workspaces",
    "desk",
    ".chats",
    chatId,
    "logs",
    `${messageId}.log`,
  );
  await fs.access(logPath).catch(() => {
    throw new NotFoundError(`No logs for message: ${messageId}`);
  });
  return { stream: createReadStream(logPath), contentType: "text/plain; charset=utf-8" };
}

/**
 * Lists a chat's attachments from the filesystem. By default returns only
 * visible (non-dot) entries — the user-uploaded chat files plus any
 * agent-finalized output. Passing `showHidden: true` includes agent
 * artifacts (dot-prefixed drafts / scratch) for the chat Artifacts panel
 * or a diagnostic view.
 */
export async function listAttachments(
  storage: StorageContext,
  chatId: string,
  opts?: { showHidden?: boolean },
): Promise<FileRef[]> {
  const dir = await chatAttachmentsDir(storage.home, chatId);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const showHidden = opts?.showHidden ?? false;
  const out: FileRef[] = [];
  for (const name of names) {
    if (!showHidden && name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    const rel = path.relative(workspaceRootPath(storage.home), abs).split(path.sep).join("/");
    out.push({
      path: rel,
      name,
      mime: "application/octet-stream",
      size: stat.size,
      createdAt: stat.birthtime.toISOString(),
    });
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

/**
 * Soft-deletes a chat. Cancels scheduler refs for every pending/recurring
 * message, deletes the chat row (FK cascade drops all message rows), and
 * moves the chat's on-disk directories to `~/Desk/.trash/`. Emits a
 * `chat.deleted` WS event with the deleted chat's ids so clients can drop
 * it from their sidebar. Returns the (now-removed) workspace id so the
 * caller can broadcast the event correctly.
 */
export async function deleteChat(
  pool: pg.Pool,
  storage: StorageContext,
  chatId: string,
  adapter: SchedulerCancelAdapter | null,
  emit: (event: WsEvent) => void,
): Promise<{ ok: true }> {
  const chat = await queries.chats.findById(pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);

  await cancelSchedulerRefsForChat(pool, chatId, adapter);

  // FK ON DELETE CASCADE drops messages rows transactionally with the chat.
  await pool.query("DELETE FROM chats WHERE id = $1", [chatId]);

  await trashChatDirectories(storage.home, chatId).catch(() => {
    // Best-effort; DB state is already gone.
  });

  emit({
    type: "chat.deleted",
    payload: { chatId, workspaceId: chat.workspaceId },
  });

  return { ok: true };
}

/**
 * Uploads a user-visible attachment to a chat. Streams directly, no DB
 * row. The storage layer rejects dot-prefixed filenames (reserved for
 * agent artifacts). Returns a FileRef with the new workspace-relative
 * path.
 */
export async function uploadAttachmentToChat(
  storage: StorageContext,
  chatId: string,
  data: { name: string; mime: string; content: Buffer },
  emit: (event: WsEvent) => void,
): Promise<FileRef> {
  const chat = await queries.chats.findById(storage.pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);

  const stream = Readable.from(data.content);

  const file = await uploadArtifact(storage, {
    workspaceId: chat.workspaceId,
    chatId,
    name: data.name,
    mime: data.mime,
    stream,
  });

  emit({ type: "artifact.created", payload: file });

  return file;
}
