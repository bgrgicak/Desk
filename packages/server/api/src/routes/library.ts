import { Readable } from "node:stream";
import pg from "pg";
import { type WsEvent } from "@desk/shared";
import {
  listLibrary,
  uploadArtifact,
  readFile,
  downloadFile,
  statFile,
  deleteFile,
  type StorageContext,
  type FileRef,
} from "@desk/storage";

export async function list(
  ctx: StorageContext,
  workspaceId: string,
  opts?: { cursor?: string; limit?: number },
) {
  return listLibrary(ctx, workspaceId, opts);
}

/**
 * Uploads a file to the workspace library. Takes a Readable directly so
 * the transport layer can pass through a multipart stream without
 * buffering.
 */
export async function upload(
  ctx: StorageContext,
  workspaceId: string,
  data: { name: string; mime: string; stream: Readable },
  emit: (event: WsEvent) => void,
): Promise<FileRef> {
  const file = await uploadArtifact(ctx, {
    workspaceId,
    name: data.name,
    mime: data.mime,
    stream: data.stream,
  });

  emit({
    type: "library.changed",
    payload: { workspaceId, path: file.path, op: "added" },
  });

  return file;
}

/** Stat metadata lookup. */
export async function get(ctx: StorageContext, relPath: string): Promise<FileRef> {
  return statFile(ctx, relPath);
}

export async function download(ctx: StorageContext, relPath: string) {
  return downloadFile(ctx, relPath);
}

export async function remove(
  ctx: StorageContext,
  workspaceId: string,
  relPath: string,
  emit: (event: WsEvent) => void,
): Promise<void> {
  await deleteFile(ctx, relPath);
  emit({
    type: "library.changed",
    payload: { workspaceId, path: relPath, op: "removed" },
  });
}

// Keep a no-op alias for legacy imports while @desk/db.pool is plumbed via ctx.
export const _unusedPool = (_pool: pg.Pool) => undefined;
export { readFile };
