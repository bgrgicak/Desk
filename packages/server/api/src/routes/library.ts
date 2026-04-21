import pg from "pg";
import { Readable } from "node:stream";
import { queries } from "@desk/db";
import { NotFoundError, generateId, type WsEvent } from "@desk/shared";
import { listLibrary, uploadArtifact, readFile, downloadFile, deleteFile, type StorageContext } from "@desk/storage";

export async function list(ctx: StorageContext, workspaceId: string, opts?: { cursor?: string; limit?: number }) {
  return listLibrary(ctx, workspaceId, opts);
}

export async function upload(
  ctx: StorageContext,
  workspaceId: string,
  data: { name: string; mime: string; contentBase64: string },
  emit: (event: WsEvent) => void,
) {
  const buf = Buffer.from(data.contentBase64, "base64");
  const stream = Readable.from(buf);

  const file = await uploadArtifact(ctx, {
    workspaceId,
    class: "library",
    name: data.name,
    mime: data.mime,
    stream,
  });

  emit({
    type: "library.changed",
    payload: { workspaceId, fileId: file.id, op: "added" },
  });

  return file;
}

export async function get(pool: pg.Pool, fileId: string) {
  const file = await queries.files.findById(pool, fileId);
  if (!file) throw new NotFoundError(`File not found: ${fileId}`);
  return file;
}

export async function download(ctx: StorageContext, fileId: string) {
  return downloadFile(ctx, fileId);
}

export async function remove(
  ctx: StorageContext,
  fileId: string,
  emit: (event: WsEvent) => void,
) {
  const file = await queries.files.findById(ctx.pool, fileId);
  if (!file) throw new NotFoundError(`File not found: ${fileId}`);

  await deleteFile(ctx, fileId);

  emit({
    type: "library.changed",
    payload: { workspaceId: file.workspaceId, fileId, op: "removed" },
  });
}

/**
 * Create a manual library note for a given library file.
 * Stores the note text as a plain-text file linked to the parent file's
 * workspace with class 'note'.
 */
export async function createNote(
  ctx: StorageContext,
  fileId: string,
  data: { text: string },
  emit: (event: WsEvent) => void,
) {
  const parentFile = await queries.files.findById(ctx.pool, fileId);
  if (!parentFile) throw new NotFoundError(`File not found: ${fileId}`);

  const buf = Buffer.from(data.text, "utf-8");
  const stream = Readable.from(buf);

  const noteFile = await uploadArtifact(ctx, {
    workspaceId: parentFile.workspaceId,
    name: `note-${fileId}.txt`,
    mime: "text/plain",
    stream,
  });

  emit({
    type: "library.changed",
    payload: { workspaceId: parentFile.workspaceId, fileId: noteFile.id, op: "added" },
  });

  return noteFile;
}
