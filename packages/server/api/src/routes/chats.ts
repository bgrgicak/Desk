import pg from "pg";
import { Readable } from "node:stream";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { queries } from "@desk/db";
import { generateId, NotFoundError, ValidationError, type Message, type WsEvent } from "@desk/shared";
import {
  chatAttachmentsDir,
  listNoteHistory,
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
  data: { title?: string; goal?: string },
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
export async function sendMessage(
  pool: pg.Pool,
  chatId: string,
  data: { content: string },
  emit: (event: WsEvent) => void,
): Promise<{ userMessage: Message; triggerId: string }> {
  const chat = await queries.chats.findById(pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);

  const userMessage = await queries.messages.insert(pool, {
    id: generateId("message"),
    chatId,
    role: "user",
    content: { type: "text", text: data.content },
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
 * cancelling state (setting state to 'cancelled'). Returns the updated
 * row. Emits message.updated over WS.
 *
 * When the previous content was a `note`, the prior body is snapshotted
 * under `.chats/{chatId}/note-history/` before the update lands, so user
 * edits and AI rewrites both leave a trail.
 */
export async function patchMessage(
  pool: pg.Pool,
  storage: StorageContext,
  chatId: string,
  messageId: string,
  data: { content?: unknown; state?: string; executeAt?: string | null; cron?: string | null },
  emit: (event: WsEvent) => void,
): Promise<Message> {
  const current = await queries.messages.findById(pool, messageId);
  if (!current || current.chatId !== chatId) {
    throw new NotFoundError(`Message not found in chat: ${messageId}`);
  }
  if (data.state !== undefined && !["cancelled", "pending"].includes(data.state)) {
    throw new ValidationError(
      `state can only be patched to 'cancelled' or 'pending' via this endpoint`,
    );
  }

  if (data.content !== undefined) {
    const prev = current.content as { type?: string; body?: string };
    if (prev?.type === "note" && typeof prev.body === "string") {
      await snapshotNote(storage.home, chatId, messageId, prev.body);
    }
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
 * Lists chat attachments directly from the filesystem. Returns workspace-
 * relative paths + stat metadata — no DB involvement.
 */
export async function listArtifacts(
  storage: StorageContext,
  chatId: string,
): Promise<FileRef[]> {
  const dir = await chatAttachmentsDir(storage.home, chatId);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: FileRef[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
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
 * Uploads an artifact to a chat's attachments dir. Streams directly, no
 * DB row. Returns a FileRef with the new path.
 */
export async function uploadArtifactToChat(
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
