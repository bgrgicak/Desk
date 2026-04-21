import pg from "pg";
import { Readable } from "node:stream";
import { queries } from "@desk/db";
import { generateId, NotFoundError, type WsEvent } from "@desk/shared";
import { uploadArtifact, type StorageContext } from "@desk/storage";

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

export async function listArtifacts(pool: pg.Pool, chatId: string) {
  return queries.files.listByChat(pool, chatId);
}

/**
 * Upload an artifact to a chat via base64 body.
 * Streams through @desk/storage.uploadArtifact with chatId context.
 */
export async function uploadArtifactToChat(
  storage: StorageContext,
  chatId: string,
  data: { name: string; mime: string; contentBase64: string },
  emit: (event: WsEvent) => void,
) {
  const chat = await queries.chats.findById(storage.pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);

  const buf = Buffer.from(data.contentBase64, "base64");
  const stream = Readable.from(buf);

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
