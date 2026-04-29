import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Pool } from "@desk/db";
import { queries } from "@desk/db";
import {
  workspaceRootPath,
  loadGitignoreFrame,
  isGitIgnored,
  type IgnoreFrame,
  type StorageContext,
} from "@desk/storage";

export interface SearchResult {
  type: "file" | "chat" | "message";
  id: string;
  title: string;
  snippet?: string;
}

/**
 * Recursively walks a directory, collecting files. By default dot-prefixed
 * entries (files and directories) and gitignored entries are skipped at
 * every level — the universal hidden rule keeps agent artifacts, hidden
 * infrastructure, and build output (`node_modules/`, `dist/`, ...) out of
 * user-facing search. Pass `showHidden: true` to include them.
 *
 * Gitignore composition only kicks in when `showHidden` is false; nested
 * `.gitignore` files are layered onto ancestors as the walk descends, so
 * each subtree sees git's exact filtering.
 */
async function walkFiles(
  root: string,
  opts: { showHidden: boolean },
  frames: IgnoreFrame[] = [],
  out: Array<{ abs: string; name: string }> = [],
): Promise<Array<{ abs: string; name: string }>> {
  const respectGitignore = !opts.showHidden;
  // Top-level call seeds the frame stack from the caller's `root`.
  const seeded = frames.length > 0
    ? frames
    : (respectGitignore ? await loadGitignoreFrame(root).then((f) => (f ? [f] : [])) : []);

  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!opts.showHidden && e.name.startsWith(".")) continue;
    const abs = path.join(root, e.name);
    const isDir = e.isDirectory();
    if (respectGitignore && isGitIgnored(abs, isDir, seeded)) continue;
    if (isDir) {
      const childFrame = respectGitignore ? await loadGitignoreFrame(abs) : null;
      const childFrames = childFrame ? [...seeded, childFrame] : seeded;
      await walkFiles(abs, opts, childFrames, out);
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
  pool: Pool,
  storage: StorageContext,
  query: string,
  scope: "artifacts" | "chats" | "library" | "all" = "all",
  opts?: { showHidden?: boolean; workspaceId?: string },
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const needle = query.toLowerCase();
  const showHidden = opts?.showHidden ?? false;
  const workspaceId = opts?.workspaceId;

  // Filesystem scopes need a concrete workspace slug. When workspaceId is
  // omitted we fall back to the full set so single-workspace callers (and
  // tests) still get results — multi-workspace callers should always scope.
  const workspaces = workspaceId
    ? await queries.workspaces.findById(pool, workspaceId).then((w) => (w ? [w] : []))
    : await queries.workspaces.list(pool);

  if (scope === "all" || scope === "library") {
    for (const ws of workspaces) {
      const root = workspaceRootPath(storage.home, ws.path);
      const libFiles = await walkFiles(root, { showHidden });
      for (const f of libFiles) {
        if (f.name.toLowerCase().includes(needle)) {
          const rel = path.relative(root, f.abs).split(path.sep).join("/");
          results.push({ type: "file", id: rel, title: f.name });
        }
      }
    }
  }

  if (scope === "all" || scope === "artifacts") {
    // Artifacts scope targets everything under `.chats/*/attachments/`.
    // That includes both user-uploaded chat files (non-dot) and
    // agent-generated artifacts (dot-prefixed). The split between the
    // two is a rendering concern for the chat UI; for search we surface
    // anything the agent or user parked in the chat's attachments dir.
    for (const ws of workspaces) {
      const root = workspaceRootPath(storage.home, ws.path);
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
  }

  if (scope === "all" || scope === "chats") {
    const pattern = `%${query}%`;
    // SQLite's LIKE is case-insensitive for ASCII by default — sufficient
    // for the latin-script titles users create. Bind params in textual
    // order: workspaceId first when present, then the pattern.
    const sql = workspaceId
      ? `SELECT id, title FROM chats WHERE workspace_id = ? AND title LIKE ? ORDER BY updated_at DESC LIMIT 20`
      : `SELECT id, title FROM chats WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 20`;
    const params = workspaceId ? [workspaceId, pattern] : [pattern];
    const { rows } = await pool.query(sql, params);
    for (const row of rows) {
      results.push({ type: "chat", id: row.id as string, title: row.title as string });
    }
  }

  return results.slice(0, 40);
}
