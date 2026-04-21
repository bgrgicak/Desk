import * as fs from "node:fs/promises";
import * as path from "node:path";
import pg from "pg";
import { NotFoundError, type File } from "@desk/shared";
import { withTx, queries } from "@desk/db";
import { libraryDir, resolveHostPath } from "./layout.js";

export interface LibraryContext {
  pool: pg.Pool;
  home: string;
}

/**
 * Lists library files for a workspace.
 */
export async function listLibrary(
  ctx: LibraryContext,
  workspaceId: string,
  opts?: { cursor?: string; limit?: number },
): Promise<{ items: File[]; nextCursor?: string }> {
  return queries.files.listByWorkspace(ctx.pool, workspaceId, {
    class: "library",
    cursor: opts?.cursor,
    limit: opts?.limit,
  });
}

/**
 * Promotes a file (e.g. a chat attachment) to the library.
 * Moves the physical file to the library directory and updates the DB row.
 */
export async function promoteToLibrary(
  ctx: LibraryContext,
  fileId: string,
): Promise<File> {
  const file = await queries.files.findById(ctx.pool, fileId);
  if (!file) {
    throw new NotFoundError(`File not found: ${fileId}`);
  }

  if (file.class === "library") {
    return file; // Already in library
  }

  const currentPath = resolveHostPath(ctx.home, file.path);
  const libDir = libraryDir(ctx.home);
  const destPath = path.join(libDir, `${file.id}-${file.name}`);

  const workspaceRoot = path.join(ctx.home, "Desk", "workspaces", "desk");
  const newStoredPath = path.relative(workspaceRoot, destPath);

  const updated = await withTx(ctx.pool, async (client) => {
    // Update DB row
    await client.query(
      `UPDATE files SET class = 'library', path = $1 WHERE id = $2`,
      [newStoredPath, fileId],
    );

    // Move the physical file
    await fs.rename(currentPath, destPath);

    const result = await queries.files.findById(client, fileId);
    return result!;
  });

  return updated;
}
