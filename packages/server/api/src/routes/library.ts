import { Readable } from "node:stream";
import pg from "pg";
import { type WsEvent } from "@desk/shared";
import {
  listLibrary,
  createLibraryFolder,
  moveLibraryEntry,
  deleteLibraryEntry,
  uploadArtifact,
  readFile,
  downloadFile,
  statFile,
  overwriteFile,
  type StorageContext,
  type FileRef,
  type FolderRef,
} from "@desk/storage";

export async function list(
  ctx: StorageContext,
  workspaceId: string,
  opts?: { cursor?: string; limit?: number; showHidden?: boolean },
) {
  return listLibrary(ctx, workspaceId, opts);
}

/**
 * Uploads a file to the workspace library. Takes a Readable directly so
 * the transport layer can pass through a multipart stream without
 * buffering. `subpath` (if provided) is a library-relative subdirectory
 * to place the file in — storage creates it recursively.
 */
export async function upload(
  ctx: StorageContext,
  workspaceId: string,
  data: { name: string; mime: string; stream: Readable; subpath?: string },
  emit: (event: WsEvent) => void,
): Promise<FileRef> {
  const file = await uploadArtifact(ctx, {
    workspaceId,
    name: data.name,
    mime: data.mime,
    stream: data.stream,
    subpath: data.subpath,
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

/**
 * Overwrites an existing library file with new content. Fails if the file
 * doesn't exist — callers wanting to create should POST to /library instead.
 */
export async function saveContent(
  ctx: StorageContext,
  workspaceId: string,
  relPath: string,
  stream: Readable,
  emit: (event: WsEvent) => void,
): Promise<FileRef> {
  const file = await overwriteFile(ctx, relPath, stream);
  emit({
    type: "library.changed",
    payload: { workspaceId, path: file.path, op: "updated" },
  });
  return file;
}

export async function download(ctx: StorageContext, relPath: string) {
  return downloadFile(ctx, relPath);
}

/**
 * Creates an empty folder inside the workspace's library. `subpath` is
 * workspace-root-relative (e.g. "Work/Plans"). Returns the created
 * FolderRef.
 */
export async function createFolder(
  ctx: StorageContext,
  workspaceId: string,
  subpath: string,
  emit: (event: WsEvent) => void,
): Promise<FolderRef> {
  const folder = await createLibraryFolder(ctx, workspaceId, subpath);
  emit({
    type: "library.changed",
    payload: { workspaceId, path: folder.path, op: "added" },
  });
  return folder;
}

/**
 * Moves or renames a library file or folder. Both paths are
 * workspace-root-relative and must belong to the same workspace —
 * cross-workspace moves are disallowed.
 */
export async function move(
  ctx: StorageContext,
  workspaceId: string,
  from: string,
  to: string,
  emit: (event: WsEvent) => void,
): Promise<{ kind: "file" | "folder"; path: string }> {
  const result = await moveLibraryEntry(ctx, workspaceId, from, to);
  emit({
    type: "library.changed",
    payload: { workspaceId, path: to, op: "moved" },
  });
  return result;
}

/**
 * Deletes a library file or folder by moving it to the trash. Works
 * for both — the storage layer inspects the path to decide.
 */
export async function remove(
  ctx: StorageContext,
  workspaceId: string,
  relPath: string,
  emit: (event: WsEvent) => void,
): Promise<void> {
  await deleteLibraryEntry(ctx, workspaceId, relPath);
  emit({
    type: "library.changed",
    payload: { workspaceId, path: relPath, op: "removed" },
  });
}

// Keep a no-op alias for legacy imports while @desk/db.pool is plumbed via ctx.
export const _unusedPool = (_pool: pg.Pool) => undefined;
export { readFile };
