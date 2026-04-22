import * as fs from "node:fs/promises";
import * as path from "node:path";
import pg from "pg";
import { chatsDir, libraryDir, workspaceRootPath, type StorageContext } from "@desk/storage";

export interface SearchResult {
  type: "file" | "chat" | "message";
  id: string;
  title: string;
  snippet?: string;
}

/**
 * Recursively walks a directory, collecting non-dot files.
 */
async function walkFiles(
  root: string,
  out: Array<{ abs: string; name: string }> = [],
): Promise<Array<{ abs: string; name: string }>> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(root, e.name);
    if (e.isDirectory()) {
      await walkFiles(abs, out);
    } else if (e.isFile()) {
      out.push({ abs, name: e.name });
    }
  }
  return out;
}

export async function search(
  pool: pg.Pool,
  storage: StorageContext,
  query: string,
  scope: "artifacts" | "chats" | "library" | "all" = "all",
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const needle = query.toLowerCase();

  if (scope === "all" || scope === "library") {
    const libFiles = await walkFiles(libraryDir(storage.home));
    for (const f of libFiles) {
      if (f.name.toLowerCase().includes(needle)) {
        const rel = path
          .relative(workspaceRootPath(storage.home), f.abs)
          .split(path.sep)
          .join("/");
        results.push({ type: "file", id: rel, title: f.name });
      }
    }
  }

  if (scope === "all" || scope === "artifacts") {
    const attachmentFiles = await walkFiles(chatsDir(storage.home));
    for (const f of attachmentFiles) {
      if (f.name.toLowerCase().includes(needle)) {
        const rel = path
          .relative(workspaceRootPath(storage.home), f.abs)
          .split(path.sep)
          .join("/");
        results.push({ type: "file", id: rel, title: f.name });
      }
    }
  }

  if (scope === "all" || scope === "chats") {
    const pattern = `%${query}%`;
    const { rows } = await pool.query(
      `SELECT id, title FROM chats WHERE title ILIKE $1 ORDER BY updated_at DESC LIMIT 20`,
      [pattern],
    );
    for (const row of rows) {
      results.push({ type: "chat", id: row.id as string, title: row.title as string });
    }
  }

  return results.slice(0, 40);
}
