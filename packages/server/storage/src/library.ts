import * as fs from "node:fs/promises";
import * as path from "node:path";
import pg from "pg";
import { workspaceLibraryDir, workspaceRootPath } from "./layout.js";
import type { FileRef } from "./files.js";

export interface LibraryContext {
  pool: pg.Pool;
  home: string;
}

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
    default: return "application/octet-stream";
  }
}

/**
 * Lists the workspace's library files by reading the library directory.
 * Filters out dotfiles and directories; returns workspace-relative paths.
 *
 * Sort is by mtime DESC. Cursor is the serialized mtime of the last
 * returned item; only items with mtime strictly less than the cursor
 * appear in the next page.
 */
export async function listLibrary(
  ctx: LibraryContext,
  workspaceId: string,
  opts?: { cursor?: string; limit?: number },
): Promise<{ items: FileRef[]; nextCursor?: string }> {
  const dir = workspaceLibraryDir(ctx.home, workspaceId);
  await fs.mkdir(dir, { recursive: true });
  const names = await fs.readdir(dir);

  const entries: FileRef[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    const relPath = path.relative(workspaceRootPath(ctx.home), abs).split(path.sep).join("/");
    entries.push({
      path: relPath,
      name,
      mime: guessMime(name),
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
    });
  }
  entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const cursor = opts?.cursor;
  const filtered = cursor
    ? entries.filter((e) => e.createdAt < cursor)
    : entries;
  const limit = opts?.limit ?? 50;
  const items = filtered.slice(0, limit);
  const nextCursor = items.length === limit ? items[items.length - 1].createdAt : undefined;
  return { items, nextCursor };
}
