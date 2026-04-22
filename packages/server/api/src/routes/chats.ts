import pg from "pg";
import { Readable } from "node:stream";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { queries } from "@desk/db";
import { generateId, NotFoundError, type WsEvent } from "@desk/shared";
import {
  chatAttachmentsDir,
  uploadArtifact,
  workspaceRootPath,
  type FileRef,
  type StorageContext,
} from "@desk/storage";

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

export async function sendMessage(
  pool: pg.Pool,
  chatId: string,
  data: { content: string },
  emit: (event: WsEvent) => void,
) {
  const chat = await queries.chats.findById(pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);

  const message = await queries.messages.insert(pool, {
    id: generateId("message"),
    chatId,
    role: "user",
    content: { type: "text", text: data.content },
  });

  emit({ type: "message.appended", payload: message });

  return message;
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
