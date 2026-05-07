import * as path from "node:path";
import { Readable } from "node:stream";
import { queries } from "@agent-desk/db";
import { ConflictError, NotFoundError, type WsEvent } from "@agent-desk/shared";
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
  indexLibraryFile,
  indexAppManifest,
  indexFragmentManifest,
  unindexLibraryPath,
  unindexLibraryTree,
  backfillWorkspaceLibrary,
  validateLibrarySubpath,
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

/**
 * Memory-system Phase 4 — every library write is mirrored into the
 * `chat_search_index` so `find_artifacts` can return notes/apps users
 * just created. Indexing is best-effort: a failure here must never
 * unwind the original write, otherwise a search-index hiccup would
 * surface as a "save failed" to the user.
 *
 * The relPath is inspected to decide which indexer to invoke:
 *   - `desk.app.json`        → indexAppManifest on the parent dir
 *   - `desk.fragment.json`   → indexFragmentManifest on the parent dir
 *   - any other library file → indexLibraryFile on the file itself
 */
async function indexLibraryWrite(
  ctx: StorageContext,
  slug: string,
  relPath: string,
): Promise<void> {
  const baseName = path.posix.basename(relPath);
  const parentRel = path.posix.dirname(relPath);
  try {
    if (baseName === "desk.app.json") {
      await indexAppManifest(ctx.pool, ctx.home, slug, parentRel === "." ? "" : parentRel);
      return;
    }
    if (baseName === "desk.fragment.json") {
      await indexFragmentManifest(ctx.pool, ctx.home, slug, parentRel === "." ? "" : parentRel);
      return;
    }
    await indexLibraryFile(ctx.pool, ctx.home, slug, relPath);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("library index hook failed:", relPath, err);
  }
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

  await indexLibraryWrite(ctx, slug, file.path);

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
  await indexLibraryWrite(ctx, slug, file.path);
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
  await indexLibraryWrite(ctx, slug, file.path);
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
  const fromRel = validateLibrarySubpath(from);
  const toRel = validateLibrarySubpath(to);
  const result = await moveLibraryEntry(ctx, slug, fromRel, toRel);
  if (result.kind === "file") {
    await queries.libraryPins.updatePinPath(ctx.pool, workspaceId, fromRel, result.path);
    // Re-key the search index from the old path to the new one.
    try {
      await unindexLibraryPath(ctx.pool, fromRel, slug);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("library unindex (move) failed:", fromRel, err);
    }
    await indexLibraryWrite(ctx, slug, result.path);
  } else {
    await queries.libraryPins.updateFolderPinPaths(ctx.pool, workspaceId, fromRel, result.path);
    try {
      await unindexLibraryTree(ctx.pool, slug, fromRel);
      await backfillWorkspaceLibrary(ctx.pool, ctx.home, slug);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("library folder reindex (move) failed:", fromRel, result.path, err);
    }
  }
  // Library paths are also embedded in `messages.attachments[].path` for
  // every chat-message that referenced this file (composer "Use in chat",
  // library mentions). Rewrite those so the chip in the message bubble
  // doesn't 404 after rename. Best-effort: a query failure here doesn't
  // undo the move. Each touched message is broadcast as `message.updated`
  // so the existing client middleware patches its per-chat cache.
  const touched = await queries.messages
    .retargetAttachmentPaths(ctx.pool, workspaceId, fromRel, result.path)
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
    payload: { workspaceId, path: result.path, op: "moved", affectedChatIds },
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
  const normalizedRelPath = validateLibrarySubpath(relPath);
  await deleteLibraryEntry(ctx, slug, normalizedRelPath);
  // Best-effort unindex. Directory deletes remove every nested index row
  // so discovery cannot return paths that were just moved to trash.
  try {
    const parent = path.posix.dirname(normalizedRelPath);
    await unindexLibraryTree(ctx.pool, slug, normalizedRelPath);
    // If a manifest's parent directory was deleted, the manifest row
    // is keyed on the parent dir — also try unindexing that.
    const baseName = path.posix.basename(normalizedRelPath);
    if (baseName === "desk.app.json" || baseName === "desk.fragment.json") {
      await unindexLibraryPath(ctx.pool, parent === "." ? "" : parent, slug);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("library unindex (remove) failed:", normalizedRelPath, err);
  }
  emit({
    type: "library.changed",
    payload: { workspaceId, path: normalizedRelPath, op: "removed" },
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
