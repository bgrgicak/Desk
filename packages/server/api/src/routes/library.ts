import { Readable } from "node:stream";
import { queries } from "@desk/db";
import { NotFoundError, type WsEvent } from "@desk/shared";
import {
  listLibrary,
  createLibraryFolder,
  createLibraryLink,
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

/**
 * Resolves a workspace's on-disk slug. Used by every library route handler
 * so storage helpers always see the correct per-workspace directory.
 */
async function resolveSlug(ctx: StorageContext, workspaceId: string): Promise<string> {
  const ws = await queries.workspaces.findById(ctx.pool, workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  return ws.path;
}

export async function list(
  ctx: StorageContext,
  workspaceId: string,
  opts?: { cursor?: string; limit?: number; showHidden?: boolean; pinned?: boolean },
) {
  const slug = await resolveSlug(ctx, workspaceId);
  const [result, authors, pinnedPaths] = await Promise.all([
    listLibrary(ctx, slug, opts),
    queries.libraryFileAuthors.listByWorkspace(ctx.pool, workspaceId),
    queries.libraryPins.listPinnedPaths(ctx.pool, workspaceId),
  ]);
  for (const item of result.items) {
    const author = authors.get(item.path);
    if (author) {
      item.agentId = author.agentId;
      if (author.creatorAgentId) item.creatorAgentId = author.creatorAgentId;
    }
    if (pinnedPaths.has(item.path)) item.pinned = true;
  }
  if (opts?.pinned) {
    result.items = result.items.filter((item) => item.pinned);
  }
  return result;
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
  const slug = await resolveSlug(ctx, workspaceId);
  const file = await uploadArtifact(ctx, {
    workspaceId,
    workspaceSlug: slug,
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
export async function get(
  ctx: StorageContext,
  workspaceId: string,
  relPath: string,
): Promise<FileRef> {
  const slug = await resolveSlug(ctx, workspaceId);
  return statFile(ctx, slug, relPath);
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
  const slug = await resolveSlug(ctx, workspaceId);
  const file = await overwriteFile(ctx, slug, relPath, stream);
  emit({
    type: "library.changed",
    payload: { workspaceId, path: file.path, op: "updated" },
  });
  return file;
}

export async function download(
  ctx: StorageContext,
  workspaceId: string,
  relPath: string,
) {
  const slug = await resolveSlug(ctx, workspaceId);
  return downloadFile(ctx, slug, relPath);
}

/**
 * Creates a URL-shortcut entry in the workspace's library. The on-disk
 * format is chosen for the host OS (.url / .webloc / .desktop) so the
 * file is openable from the host file manager too. `subpath` is
 * workspace-root-relative (e.g. "Bookmarks/Work").
 */
export async function createLink(
  ctx: StorageContext,
  workspaceId: string,
  input: { url: string; name: string; subpath?: string },
  emit: (event: WsEvent) => void,
): Promise<FileRef> {
  const slug = await resolveSlug(ctx, workspaceId);
  const file = await createLibraryLink(ctx, {
    workspaceId,
    workspaceSlug: slug,
    name: input.name,
    url: input.url,
    subpath: input.subpath,
  });
  emit({
    type: "library.changed",
    payload: { workspaceId, path: file.path, op: "added" },
  });
  return file;
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
  const slug = await resolveSlug(ctx, workspaceId);
  const folder = await createLibraryFolder(ctx, slug, subpath);
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
  const slug = await resolveSlug(ctx, workspaceId);
  const result = await moveLibraryEntry(ctx, slug, from, to);
  if (result.kind === "file") {
    await queries.libraryPins.updatePinPath(ctx.pool, workspaceId, from, to);
  } else {
    await queries.libraryPins.updateFolderPinPaths(ctx.pool, workspaceId, from, to);
  }
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
  const slug = await resolveSlug(ctx, workspaceId);
  await deleteLibraryEntry(ctx, slug, relPath);
  emit({
    type: "library.changed",
    payload: { workspaceId, path: relPath, op: "removed" },
  });
}

export async function pin(
  ctx: StorageContext,
  workspaceId: string,
  filePath: string,
): Promise<void> {
  await queries.libraryPins.pin(ctx.pool, workspaceId, filePath);
}

export async function unpin(
  ctx: StorageContext,
  workspaceId: string,
  filePath: string,
): Promise<void> {
  await queries.libraryPins.unpin(ctx.pool, workspaceId, filePath);
}

export { readFile };
