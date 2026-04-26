import * as fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import {
  NotFoundError,
  MAX_UPLOAD_BYTES,
  ValidationError,
} from "@desk/shared";
import {
  chatAttachmentsDir,
  resolveHostPath,
  tmpDir,
  trashDir,
  workspaceRootPath,
} from "./layout.js";
import { ID_PREFIXES } from "@desk/shared";

/**
 * Per-request storage context — carries the DB pool + Desk home root.
 * Workspace-scoped helpers take a `slug` alongside this context so
 * every workspace's files live under their own directory.
 */
export interface StorageContext {
  pool: pg.Pool;
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
async function uniqueDestPath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (true) {
    try {
      await fs.access(path.join(dir, candidate));
      candidate = `${stem}-${i}${ext}`;
      i += 1;
    } catch {
      return path.join(dir, candidate);
    }
  }
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
  };
}

async function fileRefFromDisk(home: string, slug: string, relPath: string): Promise<FileRef> {
  const abs = resolveHostPath(home, slug, relPath);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new NotFoundError(`File not found: ${relPath}`);
  if (!stat.isFile()) throw new NotFoundError(`Not a file: ${relPath}`);
  return {
    path: relPath.split(path.sep).join("/"),
    name: path.basename(abs),
    mime: guessMime(abs),
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
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
  // Leave a symlink at the old path pointing to the new absolute location.
  await fs.symlink(toAbs, fromAbs).catch(() => {
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
 * Soft-deletes a chat's on-disk footprint by moving `.chats/{chatId}/`
 * (which holds attachments, logs, and note-history) into
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
