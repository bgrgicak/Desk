import { Readable } from "node:stream";
import { queries } from "@agent-desk/db";
import { ConflictError, NotFoundError, ValidationError, type WsEvent } from "@agent-desk/shared";
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
} from "@agent-desk/storage";

/**
 * Resolves a workspace's on-disk slug. Used by every library route handler
 * so storage helpers always see the correct per-workspace directory.
 */
async function resolveSlug(ctx: StorageContext, workspaceId: string): Promise<string> {
  const ws = await queries.workspaces.findById(ctx.pool, workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  return ws.path;
}

function normalizePinnedLibraryPath(rawPath: string): string {
  const normalized = rawPath.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!normalized) throw new ValidationError("Missing 'path' in body");
  return normalized;
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
 * Saves content to a library file. Creates the file (and parent dirs) if
 * it doesn't exist yet, or overwrites in place. This lets hidden files
 * created by the agent (`.memory/workspace.md`, etc.) be saved through
 * the same PUT endpoint as any other file.
 *
 * When `ifMatch` is provided it is compared against the file's current mtime
 * (in milliseconds). A mismatch throws ConflictError so the caller can respond
 * with 409 and the current file content for client-side merge.
 */
export async function saveContent(
  ctx: StorageContext,
  workspaceId: string,
  relPath: string,
  stream: Readable,
  emit: (event: WsEvent) => void,
  ifMatch?: string,
): Promise<FileRef> {
  const slug = await resolveSlug(ctx, workspaceId);
  if (ifMatch !== undefined) {
    const current = await statFile(ctx, slug, relPath);
    if (current.updatedAtMs !== ifMatch) {
      throw new ConflictError(`File modified since ${ifMatch}`);
    }
  }
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
  // Library paths are also embedded in `messages.attachments[].path` for
  // every chat-message that referenced this file (composer "Use in chat",
  // library mentions). Rewrite those so the chip in the message bubble
  // doesn't 404 after rename. Best-effort: a query failure here doesn't
  // undo the move. Each touched message is broadcast as `message.updated`
  // so the existing client middleware patches its per-chat cache.
  const touched = await queries.messages
    .retargetAttachmentPaths(ctx.pool, workspaceId, from, to)
    .catch(() => [] as Awaited<ReturnType<typeof queries.messages.retargetAttachmentPaths>>);
  for (const m of touched) {
    emit({ type: "message.updated", payload: m });
  }
  // Union of chats whose symlinks were retargeted (Files-panel listing)
  // and chats whose messages were rewritten (message-bubble chips). The
  // client uses this to invalidate per-chat caches.
  const affectedChatIds = Array.from(
    new Set([...result.affectedChatIds, ...touched.map((m) => m.chatId)]),
  );
  emit({
    type: "library.changed",
    payload: { workspaceId, path: to, op: "moved", affectedChatIds },
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
  const slug = await resolveSlug(ctx, workspaceId);
  const normalizedPath = normalizePinnedLibraryPath(filePath);
  // Validate the target and canonicalize path variants before writing the pin.
  // Without this, callers can create stale duplicate pin rows such as
  // `foo.app` and `foo.app/`, which makes the sidebar/list state drift from
  // the actual library contents.
  await statFile(ctx, slug, normalizedPath);
  await queries.libraryPins.pin(ctx.pool, workspaceId, normalizedPath);
}

export async function unpin(
  ctx: StorageContext,
  workspaceId: string,
  filePath: string,
): Promise<void> {
  const normalizedPath = normalizePinnedLibraryPath(filePath);
  await queries.libraryPins.unpin(ctx.pool, workspaceId, normalizedPath);
}

export { readFile };
