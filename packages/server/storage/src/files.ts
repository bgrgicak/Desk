import * as fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type Pool } from "@agent-desk/db";
import {
  NotFoundError,
  MAX_UPLOAD_BYTES,
  ValidationError,
} from "@agent-desk/shared";
import {
  chatAttachmentsDir,
  resolveHostPath,
  tmpDir,
  trashDir,
  workspaceRootPath,
} from "./layout.js";
import { ID_PREFIXES } from "@agent-desk/shared";

/**
 * Per-request storage context — carries the DB pool + Desk home root.
 * Workspace-scoped helpers take a `slug` alongside this context so
 * every workspace's files live under their own directory.
 */
export interface StorageContext {
  pool: Pool;
  home: string;
}

export interface UploadArtifactInput {
  /** Workspace whose on-disk slug this upload is destined for. */
  workspaceId: string;
  /** The workspace's `path` column — the directory name under `~/Desk/workspaces/`. */
  workspaceSlug: string;
  chatId?: string;
  name: string;
  mime: string;
  stream: Readable;
  /**
   * Optional workspace-root-relative subdirectory (e.g. "Projects/Q2").
   * Only applies to library uploads (no chatId). Created recursively if
   * missing. Rejected if it contains `..` segments, absolute paths, or
   * dotfile segments.
   */
  subpath?: string;
}

export interface FileRef {
  /** Workspace-relative path, uses forward slashes. */
  path: string;
  /** The final on-disk filename (may differ from `input.name` if a collision was avoided). */
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  /** Last-modified time as a Unix millisecond timestamp string — used as an ETag. */
  updatedAtMs: string;
  /** ID of the agent that *last* created or edited this file, if known. */
  agentId?: string;
  /** ID of the agent that *originally* created this file, if known. Stays
   * stable even after subsequent human or agent edits — used by the
   * Library UI to show a "by AI" provenance label. */
  creatorAgentId?: string;
  /** Whether this file is pinned in the workspace's Pinned view. */
  pinned?: boolean;
  /** True when this entry is a directory (e.g. a `.app/` bundle). */
  isDir?: boolean;
}

/** Extension-to-mime guesser used when the caller didn't provide one. */
function guessMime(name: string): string {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case ".txt": return "text/plain";
    case ".md": return "text/markdown";
    case ".json": return "application/json";
    case ".html": return "text/html";
    case ".pdf": return "application/pdf";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    default: return "application/octet-stream";
  }
}

/**
 * Validates and normalizes a workspace-root-relative subdirectory.
 * Returns the cleaned subpath with forward slashes, or "" for the root.
 *
 * Rejects: absolute paths, `..` traversal, empty segments, segments
 * starting with `.` (hidden — reserved for agent artifacts / infrastructure),
 * backslashes.
 */
export function validateLibrarySubpath(raw: string | undefined): string {
  if (!raw) return "";
  if (raw.includes("\\")) {
    throw new ValidationError(`Invalid subpath: ${raw}`);
  }
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") return "";
  const segments = trimmed.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === ".." || seg.startsWith(".")) {
      throw new ValidationError(`Invalid subpath segment: ${seg}`);
    }
  }
  return segments.join("/");
}

/**
 * Rejects filenames reserved for hidden (agent-origin) content. The dotfile
 * convention governs user-visibility workspace-wide; user uploads must
 * always be visible.
 */
function rejectHiddenName(name: string): void {
  if (name.startsWith(".")) {
    throw new ValidationError(
      `Filenames starting with '.' are reserved for agent artifacts. Please rename '${name}' to remove the leading dot.`,
    );
  }
}

/** Generates a non-colliding filename inside `dir` for a desired `name`. */
export async function uniqueDestPath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (true) {
    try {
      await fs.lstat(path.join(dir, candidate));
      candidate = `${stem}-${i}${ext}`;
      i += 1;
    } catch {
      return path.join(dir, candidate);
    }
  }
}

/**
 * Symlinks inside the workspace must survive the sandbox mount, where the
 * same tree appears under /home/agent instead of the host's absolute path.
 */
export function relativeSymlinkTarget(linkPath: string, targetAbs: string): string {
  return path.relative(path.dirname(linkPath), targetAbs).split(path.sep).join("/") || ".";
}

/**
 * Uploads a file to the filesystem. No DB row is written — the FS is the
 * single source of truth. Returns a FileRef describing the workspace-relative
 * path and stat metadata.
 *
 * User uploads must not be dotfile-named. Agent-origin files write through
 * the sandbox filesystem, not this route.
 */
export async function uploadArtifact(
  ctx: StorageContext,
  input: UploadArtifactInput,
): Promise<FileRef> {
  rejectHiddenName(input.name);

  const tmpPath = path.join(tmpDir(ctx.home), crypto.randomUUID());

  let destDir: string;
  if (input.chatId) {
    destDir = await chatAttachmentsDir(ctx.home, input.workspaceSlug, input.chatId);
  } else {
    const root = workspaceRootPath(ctx.home, input.workspaceSlug);
    const sub = validateLibrarySubpath(input.subpath);
    destDir = sub ? path.join(root, sub) : root;
  }
  await fs.mkdir(destDir, { recursive: true });

  const destPath = await uniqueDestPath(destDir, input.name);

  // Stream to temp file, enforcing size limit
  let size = 0;
  const sizeEnforcer = new (await import("node:stream")).Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        callback(new ValidationError(`File exceeds maximum size of ${MAX_UPLOAD_BYTES} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(input.stream, sizeEnforcer, createWriteStream(tmpPath));
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }

  try {
    await fs.rename(tmpPath, destPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }

  const stat = await fs.stat(destPath);
  const relPath = path.relative(workspaceRootPath(ctx.home, input.workspaceSlug), destPath);

  return {
    path: relPath.split(path.sep).join("/"),
    name: path.basename(destPath),
    mime: input.mime || guessMime(input.name),
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
    updatedAtMs: String(stat.mtimeMs),
  };
}

async function fileRefFromDisk(home: string, slug: string, relPath: string): Promise<FileRef> {
  const abs = resolveHostPath(home, slug, relPath);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new NotFoundError(`File not found: ${relPath}`);
  // Allow `.app/` directories to be stat'd so the frontend can render them
  // as app iframes. Other directories are still rejected.
  if (stat.isDirectory()) {
    const name = path.basename(abs);
    if (!name.endsWith(".app") || name === ".app") {
      throw new NotFoundError(`Not a file: ${relPath}`);
    }
    return {
      path: relPath.split(path.sep).join("/"),
      name,
      mime: "inode/directory",
      size: 0,
      createdAt: stat.birthtime.toISOString(),
      updatedAtMs: String(stat.mtimeMs),
      isDir: true,
    };
  }
  if (!stat.isFile()) throw new NotFoundError(`Not a file: ${relPath}`);
  return {
    path: relPath.split(path.sep).join("/"),
    name: path.basename(abs),
    mime: guessMime(abs),
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
    updatedAtMs: String(stat.mtimeMs),
  };
}

/**
 * Opens a file for reading. The `ref` is the workspace-relative path
 * returned by uploadArtifact / listLibrary.
 */
export async function readFile(
  ctx: StorageContext,
  slug: string,
  relPath: string,
): Promise<{ stream: Readable; file: FileRef }> {
  const file = await fileRefFromDisk(ctx.home, slug, relPath);
  const abs = resolveHostPath(ctx.home, slug, relPath);
  const stream = createReadStream(abs);
  return { stream, file };
}

/** Alias — callers that want the download semantics. */
export async function downloadFile(
  ctx: StorageContext,
  slug: string,
  relPath: string,
): Promise<{ stream: Readable; file: FileRef }> {
  return readFile(ctx, slug, relPath);
}

/**
 * Stat a file without opening a read stream. Throws NotFoundError if missing.
 */
export async function statFile(
  ctx: StorageContext,
  slug: string,
  relPath: string,
): Promise<FileRef> {
  return fileRefFromDisk(ctx.home, slug, relPath);
}

/**
 * Overwrites an existing library file's contents in place. Unlike
 * `uploadArtifact`, this requires the file to already exist — it will not
 * create a new file or auto-rename on collision. Writes through a temp
 * file + atomic rename so partial writes don't leave the target truncated.
 */
export async function overwriteFile(
  ctx: StorageContext,
  slug: string,
  relPath: string,
  stream: Readable,
): Promise<FileRef> {
  const abs = resolveHostPath(ctx.home, slug, relPath);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new NotFoundError(`File not found: ${relPath}`);
  if (!stat.isFile()) throw new NotFoundError(`Not a file: ${relPath}`);

  const tmpPath = path.join(tmpDir(ctx.home), crypto.randomUUID());
  let size = 0;
  const sizeEnforcer = new (await import("node:stream")).Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        callback(new ValidationError(`File exceeds maximum size of ${MAX_UPLOAD_BYTES} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(stream, sizeEnforcer, createWriteStream(tmpPath));
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  try {
    await fs.rename(tmpPath, abs);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  return fileRefFromDisk(ctx.home, slug, relPath);
}

/**
 * Pins an existing library file to a chat by symlinking it into the
 * chat's `.chats/{chatId}/attachments/` directory. The library file is
 * not copied or moved — the symlink exists purely so `listAttachments`
 * surfaces the pinned file in the chat's "In this chat" sidebar list.
 *
 * Idempotent: if a symlink with the same basename already points at the
 * same target, returns its FileRef unchanged. On basename collision with
 * a different target, falls back to the same `name-1.ext` rename scheme
 * `uploadArtifact` uses.
 *
 * Returns a FileRef whose `path` is the symlink's workspace-relative
 * path (under `.chats/{chatId}/attachments/`). `fs.stat` follows the
 * link, so size / createdAt reflect the underlying library file.
 */
export async function pinLibraryFileToChat(
  ctx: StorageContext,
  slug: string,
  chatId: string,
  libraryRelPath: string,
): Promise<FileRef> {
  const targetAbs = resolveHostPath(ctx.home, slug, libraryRelPath);
  const targetStat = await fs.stat(targetAbs).catch(() => null);
  if (!targetStat) throw new NotFoundError(`File not found: ${libraryRelPath}`);
  if (!targetStat.isFile()) throw new ValidationError(`Not a file: ${libraryRelPath}`);

  const root = workspaceRootPath(ctx.home, slug);
  const attDir = await chatAttachmentsDir(ctx.home, slug, chatId);

  // A library path that already lives inside this chat's attachments dir
  // is already pinned (or is a chat-local upload). Pinning it would
  // create a self-referential symlink — refuse.
  if (targetAbs === attDir || targetAbs.startsWith(attDir + path.sep)) {
    throw new ValidationError(`Cannot pin a file that is already a chat attachment: ${libraryRelPath}`);
  }

  const desiredName = path.basename(targetAbs);
  rejectHiddenName(desiredName);

  const sameNameAbs = path.join(attDir, desiredName);
  const existingTarget = await fs.readlink(sameNameAbs).catch(() => null);
  if (existingTarget !== null) {
    // Existing symlink at the desired name. If it points at the same
    // library file, this pin is a no-op — return its FileRef.
    const resolvedExisting = path.isAbsolute(existingTarget)
      ? existingTarget
      : path.resolve(attDir, existingTarget);
    if (resolvedExisting === targetAbs) {
      const portableTarget = relativeSymlinkTarget(sameNameAbs, targetAbs);
      if (existingTarget !== portableTarget) {
        await fs.unlink(sameNameAbs);
        await fs.symlink(portableTarget, sameNameAbs);
      }
      const stat = await fs.stat(sameNameAbs).catch(() => null);
      if (stat) {
        const relPath = path.relative(root, sameNameAbs).split(path.sep).join("/");
        return {
          path: relPath,
          name: desiredName,
          mime: guessMime(desiredName),
          size: stat.size,
          createdAt: stat.birthtime.toISOString(),
          updatedAtMs: String(stat.mtimeMs),
        };
      }
    }
  }

  const linkPath = await uniqueDestPath(attDir, desiredName);
  await fs.symlink(relativeSymlinkTarget(linkPath, targetAbs), linkPath);

  const stat = await fs.stat(linkPath);
  const relPath = path.relative(root, linkPath).split(path.sep).join("/");
  return {
    path: relPath,
    name: path.basename(linkPath),
    mime: guessMime(linkPath),
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
    updatedAtMs: String(stat.mtimeMs),
  };
}

/**
 * Promotes a chat attachment from `.chats/{chatId}/attachments/` into the
 * primary workspace library (optionally inside `destSubpath`). The original
 * location is replaced with a symlink to the new path so the chat's
 * `listAttachments()` continues to surface the file.
 *
 * `attachmentName` must be a basename — the source is always
 * `.chats/{chatId}/attachments/{attachmentName}`. Rejects when the source is
 * already a symlink (i.e. a previously-pinned library file): a chat-pinned
 * library reference is already in the library, so re-saving is meaningless.
 *
 * Name collisions in the destination directory are resolved by suffixing
 * `-1`, `-2`, …, mirroring `uploadArtifact`'s scheme.
 */
export async function saveChatAttachmentToLibrary(
  ctx: StorageContext,
  slug: string,
  chatId: string,
  attachmentName: string,
  destSubpath?: string,
): Promise<FileRef> {
  if (path.basename(attachmentName) !== attachmentName) {
    throw new ValidationError(`Invalid attachment name: ${attachmentName}`);
  }
  rejectHiddenName(attachmentName);

  const sub = validateLibrarySubpath(destSubpath);
  const root = workspaceRootPath(ctx.home, slug);
  const attDir = await chatAttachmentsDir(ctx.home, slug, chatId);
  const srcAbs = path.join(attDir, attachmentName);

  const srcStat = await fs.lstat(srcAbs).catch(() => null);
  if (!srcStat) throw new NotFoundError(`Attachment not found: ${attachmentName}`);
  if (srcStat.isSymbolicLink()) {
    throw new ValidationError(
      `Attachment is already a library reference: ${attachmentName}`,
    );
  }
  if (!srcStat.isFile()) throw new ValidationError(`Not a file: ${attachmentName}`);

  const destDir = sub ? path.join(root, sub) : root;
  await fs.mkdir(destDir, { recursive: true });
  const destAbs = await uniqueDestPath(destDir, attachmentName);

  await fs.rename(srcAbs, destAbs);
  // Best-effort: leave a symlink at the old path so the chat still shows
  // the file via `listAttachments`. If the symlink can't be created the
  // save still succeeded — the chat sidebar will just lose the row.
  await fs.symlink(relativeSymlinkTarget(srcAbs, destAbs), srcAbs).catch(() => {});

  const relPath = path.relative(root, destAbs).split(path.sep).join("/");
  return fileRefFromDisk(ctx.home, slug, relPath);
}

/**
 * Move a file from one workspace-relative path to another. Leaves a symlink
 * at the old path pointing to the new absolute path so existing references
 * remain valid.
 */
export async function moveFile(
  ctx: StorageContext,
  slug: string,
  fromRel: string,
  toRel: string,
): Promise<FileRef> {
  const fromAbs = resolveHostPath(ctx.home, slug, fromRel);
  const toAbs = resolveHostPath(ctx.home, slug, toRel);
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.rename(fromAbs, toAbs);
  // Leave a symlink at the old path pointing to the new location.
  await fs.symlink(relativeSymlinkTarget(fromAbs, toAbs), fromAbs).catch(() => {
    // If the symlink can't be created (e.g. parent dir gone), swallow — the
    // move still succeeded; references to the old path will fail-fast.
  });
  return fileRefFromDisk(ctx.home, slug, toRel);
}

/**
 * "Delete" a file by moving it to ~/Desk/.trash/{timestamp}-{name}.
 * The file stays on disk until the trash is purged. After delete, the
 * original path no longer resolves — subsequent reads/stats return 404.
 * The trash itself is not mounted into sandboxes, so the agent cannot
 * see deleted files.
 */
export async function deleteFile(
  ctx: StorageContext,
  slug: string,
  relPath: string,
): Promise<void> {
  const abs = resolveHostPath(ctx.home, slug, relPath);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new NotFoundError(`File not found: ${relPath}`);
  if (!stat.isFile()) throw new NotFoundError(`Not a file: ${relPath}`);

  const trash = trashDir(ctx.home);
  await fs.mkdir(trash, { recursive: true });
  const stamp = Date.now();
  const trashPath = path.join(trash, `${stamp}-${path.basename(abs)}`);
  await fs.rename(abs, trashPath);
}

/**
 * Removes a single entry from `.chats/{chatId}/attachments/`. Works for
 * symlinks (library pins) and regular files (direct chat uploads): the
 * unlink only touches the entry inside the chat dir, so a pinned
 * library file's source stays put. Hidden / dot-prefixed names are
 * rejected because that namespace belongs to agent infrastructure and
 * isn't user-removable from the Files panel.
 */
export async function removeChatAttachment(
  ctx: StorageContext,
  slug: string,
  chatId: string,
  attachmentName: string,
): Promise<void> {
  if (path.basename(attachmentName) !== attachmentName) {
    throw new ValidationError(`Invalid attachment name: ${attachmentName}`);
  }
  rejectHiddenName(attachmentName);
  const attDir = await chatAttachmentsDir(ctx.home, slug, chatId);
  const linkPath = path.join(attDir, attachmentName);
  // lstat (not stat) so a dangling symlink — pointing at a deleted
  // library file — still reports the entry's existence and we can
  // unlink it like any other.
  const stat = await fs.lstat(linkPath).catch(() => null);
  if (!stat) throw new NotFoundError(`Attachment not found: ${attachmentName}`);
  await fs.unlink(linkPath);
}

/**
 * Soft-deletes a chat's on-disk footprint by moving `.chats/{chatId}/`
 * (which holds attachments, logs, and notes/) into
 * `~/Desk/.trash/.chats/`. Idempotent — missing dirs are silently skipped.
 */
export async function trashChatDirectories(
  home: string,
  slug: string,
  chatId: string,
): Promise<{ moved: boolean }> {
  if (!chatId.startsWith(ID_PREFIXES.chat) || chatId.includes("/") || chatId.includes("..")) {
    throw new ValidationError(`Invalid chat id: ${chatId}`);
  }
  const root = workspaceRootPath(home, slug);
  const stamp = Date.now();

  const src = path.join(root, ".chats", chatId);
  const dst = path.join(trashDir(home), ".chats", `${chatId}-${stamp}`);

  const stat = await fs.stat(src).catch(() => null);
  if (!stat) return { moved: false };

  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.rename(src, dst);
  return { moved: true };
}

/**
 * Resolves an absolute host path for a workspace-relative path so the
 * runtime can project it into a sandbox mount. Kept for backward-compat
 * with the pre-FS API; simple wrapper over resolveHostPath.
 */
export async function resolveForSandbox(
  ctx: StorageContext,
  slug: string,
  relPath: string,
): Promise<string> {
  await fileRefFromDisk(ctx.home, slug, relPath);
  return resolveHostPath(ctx.home, slug, relPath);
}
