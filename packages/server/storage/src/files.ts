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
  workspaceLibraryDir,
  workspaceRootPath,
} from "./layout.js";

/**
 * v1 keeps a `pool` on the context for callers that still want a handle;
 * the filesystem path is what actually matters.
 */
export interface StorageContext {
  pool: pg.Pool;
  home: string;
}

export interface UploadArtifactInput {
  workspaceId: string;
  chatId?: string;
  name: string;
  mime: string;
  stream: Readable;
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
 */
export async function uploadArtifact(
  ctx: StorageContext,
  input: UploadArtifactInput,
): Promise<FileRef> {
  const tmpPath = path.join(tmpDir(ctx.home), crypto.randomUUID());

  let destDir: string;
  if (input.chatId) {
    destDir = await chatAttachmentsDir(ctx.home, input.chatId);
  } else {
    destDir = workspaceLibraryDir(ctx.home, input.workspaceId);
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
  const relPath = path.relative(workspaceRootPath(ctx.home), destPath);

  return {
    path: relPath.split(path.sep).join("/"),
    name: path.basename(destPath),
    mime: input.mime || guessMime(input.name),
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
  };
}

async function fileRefFromDisk(home: string, relPath: string): Promise<FileRef> {
  const abs = resolveHostPath(home, relPath);
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
  relPath: string,
): Promise<{ stream: Readable; file: FileRef }> {
  const file = await fileRefFromDisk(ctx.home, relPath);
  const abs = resolveHostPath(ctx.home, relPath);
  const stream = createReadStream(abs);
  return { stream, file };
}

/** Alias — callers that want the download semantics. */
export async function downloadFile(
  ctx: StorageContext,
  relPath: string,
): Promise<{ stream: Readable; file: FileRef }> {
  return readFile(ctx, relPath);
}

/**
 * Stat a file without opening a read stream. Throws NotFoundError if missing.
 */
export async function statFile(ctx: StorageContext, relPath: string): Promise<FileRef> {
  return fileRefFromDisk(ctx.home, relPath);
}

/**
 * Move a file from one workspace-relative path to another. Leaves a symlink
 * at the old path pointing to the new absolute path so existing references
 * remain valid.
 */
export async function moveFile(
  ctx: StorageContext,
  fromRel: string,
  toRel: string,
): Promise<FileRef> {
  const fromAbs = resolveHostPath(ctx.home, fromRel);
  const toAbs = resolveHostPath(ctx.home, toRel);
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.rename(fromAbs, toAbs);
  // Leave a symlink at the old path pointing to the new absolute location.
  await fs.symlink(toAbs, fromAbs).catch(() => {
    // If the symlink can't be created (e.g. parent dir gone), swallow — the
    // move still succeeded; references to the old path will fail-fast.
  });
  return fileRefFromDisk(ctx.home, toRel);
}

/**
 * "Delete" a file by moving it to ~/Desk/.trash/{timestamp}-{name}.
 * The file stays on disk until the trash is purged. After delete, the
 * original path no longer resolves — subsequent reads/stats return 404.
 * The trash itself is not mounted into sandboxes, so the agent cannot
 * see deleted files.
 */
export async function deleteFile(ctx: StorageContext, relPath: string): Promise<void> {
  const abs = resolveHostPath(ctx.home, relPath);
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
 * Resolves an absolute host path for a workspace-relative path so the
 * runtime can project it into a sandbox mount. Kept for backward-compat
 * with the pre-FS API; simple wrapper over resolveHostPath.
 */
export async function resolveForSandbox(
  ctx: StorageContext,
  relPath: string,
): Promise<string> {
  await fileRefFromDisk(ctx.home, relPath);
  return resolveHostPath(ctx.home, relPath);
}
