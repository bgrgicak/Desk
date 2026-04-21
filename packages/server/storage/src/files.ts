import * as fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import {
  generateId,
  NotFoundError,
  MAX_UPLOAD_BYTES,
  ValidationError,
  type File,
} from "@desk/shared";
import { withTx, queries } from "@desk/db";
import { chatAttachmentsDir, filesDir, libraryDir, tmpDir, resolveHostPath } from "./layout.js";

export interface StorageContext {
  pool: pg.Pool;
  home: string;
}

export interface UploadArtifactInput {
  workspaceId: string;
  chatId?: string;
  class?: string;
  name: string;
  mime: string;
  stream: Readable;
}

/**
 * Uploads a file to disk and inserts a DB row.
 * Uses a transaction: writes to a temp file first, then moves atomically.
 */
export async function uploadArtifact(
  ctx: StorageContext,
  input: UploadArtifactInput,
): Promise<File> {
  const fileId = generateId("file");
  const tmpPath = path.join(tmpDir(ctx.home), `${fileId}-${crypto.randomUUID()}`);

  // Determine destination directory based on class + context.
  // Class takes precedence: `library` always lives under library/, even if
  // somehow a chatId is also provided. Chat-scoped uploads without an
  // explicit class default to `artifact`. Everything else lands in files/.
  const fileClass = input.class ?? (input.chatId ? "artifact" : "workspace");
  let destDir: string;
  if (fileClass === "library") {
    destDir = libraryDir(ctx.home);
  } else if (input.chatId) {
    destDir = await chatAttachmentsDir(ctx.home, input.chatId);
  } else {
    destDir = filesDir(ctx.home);
  }
  const destPath = path.join(destDir, `${fileId}-${input.name}`);

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
    // Clean up temp file on any failure
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }

  // Compute the stored path relative to the workspace root
  const workspaceRoot = path.join(ctx.home, "Desk", "workspaces", "desk");
  const storedPath = path.relative(workspaceRoot, destPath);

  try {
    const file = await withTx(ctx.pool, async (client) => {
      const row = await queries.files.insert(client, {
        id: fileId,
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        class: fileClass,
        path: storedPath,
        name: input.name,
        mime: input.mime,
        size,
      });

      // Move temp file into place (atomic on same filesystem)
      await fs.rename(tmpPath, destPath);

      return row;
    });

    return file;
  } catch (err) {
    // Clean up on failure
    await fs.unlink(tmpPath).catch(() => {});
    await fs.unlink(destPath).catch(() => {});
    throw err;
  }
}

/**
 * Reads a file by ID, returning its stream and metadata.
 */
export async function readFile(
  ctx: StorageContext,
  fileId: string,
): Promise<{ stream: Readable; file: File }> {
  const file = await queries.files.findById(ctx.pool, fileId);
  if (!file) {
    throw new NotFoundError(`File not found: ${fileId}`);
  }

  const hostPath = resolveHostPath(ctx.home, file.path);
  try {
    await fs.access(hostPath);
  } catch {
    throw new NotFoundError(`File missing from disk: ${fileId}`);
  }

  const stream = createReadStream(hostPath);
  return { stream, file };
}

/**
 * Downloads a file — alias for readFile. Caller sets appropriate headers.
 */
export async function downloadFile(
  ctx: StorageContext,
  fileId: string,
): Promise<{ stream: Readable; file: File }> {
  return readFile(ctx, fileId);
}

/**
 * Deletes a file: unlinks from disk and removes the DB row.
 */
export async function deleteFile(
  ctx: StorageContext,
  fileId: string,
): Promise<void> {
  const file = await queries.files.findById(ctx.pool, fileId);
  if (!file) {
    throw new NotFoundError(`File not found: ${fileId}`);
  }

  const hostPath = resolveHostPath(ctx.home, file.path);

  // Delete DB row first, then unlink
  await queries.files.deleteById(ctx.pool, fileId);
  await fs.unlink(hostPath).catch(() => {
    // File may already be gone — not critical
  });
}

/**
 * Resolves the absolute host path for a file, used by @desk/runtime for mount projection.
 */
export async function resolveForSandbox(
  ctx: StorageContext,
  fileId: string,
): Promise<string> {
  const file = await queries.files.findById(ctx.pool, fileId);
  if (!file) {
    throw new NotFoundError(`File not found: ${fileId}`);
  }
  return resolveHostPath(ctx.home, file.path);
}
