import * as fs from "node:fs/promises";
import * as path from "node:path";
import pg from "pg";
import { workspaceRootPath, type StorageContext } from "@desk/storage";

export interface SearchResult {
  type: "file" | "chat" | "message";
  id: string;
  title: string;
  snippet?: string;
}

/**
 * Recursively walks a directory, collecting files. By default dot-prefixed
 * entries (files and directories) are skipped at every level — the
 * universal dotfile rule keeps agent artifacts and hidden infrastructure
 * out of user-facing search. Pass `showHidden: true` to include them.
 */
async function walkFiles(
  root: string,
  opts: { showHidden: boolean },
  out: Array<{ abs: string; name: string }> = [],
): Promise<Array<{ abs: string; name: string }>> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!opts.showHidden && e.name.startsWith(".")) continue;
    const abs = path.join(root, e.name);
    if (e.isDirectory()) {
      await walkFiles(abs, opts, out);
    } else if (e.isFile()) {
      out.push({ abs, name: e.name });
    }
  }
  return out;
}

/**
 * Workspace-wide search.
 *
 * Library / artifact scopes now walk the same tree (the workspace root)
 * and filter by visibility:
 *   - library scope returns only non-dot files (user-visible content).
 *   - artifacts scope returns only dot-prefixed files under `.chats/*`
 *     (agent-generated drafts) — these are "hidden" by default but are
 *     the explicit target of the artifacts scope.
 *
 * `showHidden` flips the library scope to include hidden files too.
 */
export async function search(
  pool: pg.Pool,
  storage: StorageContext,
  query: string,
  scope: "artifacts" | "chats" | "library" | "all" = "all",
  opts?: { showHidden?: boolean },
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const needle = query.toLowerCase();
  const root = workspaceRootPath(storage.home);
  const showHidden = opts?.showHidden ?? false;

  if (scope === "all" || scope === "library") {
    const libFiles = await walkFiles(root, { showHidden });
    for (const f of libFiles) {
      if (f.name.toLowerCase().includes(needle)) {
        const rel = path.relative(root, f.abs).split(path.sep).join("/");
        results.push({ type: "file", id: rel, title: f.name });
      }
    }
  }

  if (scope === "all" || scope === "artifacts") {
    // Artifacts scope targets everything under `.chats/*/attachments/`.
    // That includes both user-uploaded chat files (non-dot) and
    // agent-generated artifacts (dot-prefixed). The split between the
    // two is a rendering concern for the chat UI; for search we surface
    // anything the agent or user parked in the chat's attachments dir.
    const chatsRoot = path.join(root, ".chats");
    const chatDirs = await fs.readdir(chatsRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of chatDirs) {
      if (!entry.isDirectory()) continue;
      const attachmentsDir = path.join(chatsRoot, entry.name, "attachments");
      const files = await walkFiles(attachmentsDir, { showHidden: true });
      for (const f of files) {
        if (f.name.toLowerCase().includes(needle)) {
          const rel = path.relative(root, f.abs).split(path.sep).join("/");
          results.push({ type: "file", id: rel, title: f.name });
        }
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
