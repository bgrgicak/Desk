import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Pool } from "@agent-desk/db";
import {
  AppManifestSchema,
  FragmentManifestSchema,
  type AppManifest,
  type FragmentManifest,
} from "@agent-desk/shared";
import { workspaceRootPath } from "./layout.js";

/**
 * Memory-system Phase 4 (P4.3 + P4.4) — index workspace library
 * content into the same `chat_search_index` table used by Phase 3 for
 * chat messages and summaries. The discovery tool (`find_artifacts`)
 * queries the same table with `kind IN ('note', 'doc', 'app',
 * 'fragment')`.
 *
 * The index uses (kind, ref_id) as the primary key. For library
 * content `ref_id` is the workspace-relative path (no leading `/`).
 *
 * Triggers cover messages; library content has no DB rows of its own,
 * so the API surface here is called explicitly by:
 *   - `saveLibraryContent` / file upload routes (insert / update)
 *   - `deleteLibraryEntry` / `removeChatAttachment` (delete)
 *   - `backfillWorkspace`, fired once on server boot
 *
 * Failure to index is logged but never thrown — the index is a search
 * optimisation, not a source of truth.
 */

export type LibraryKind = "note" | "doc" | "app" | "fragment";

const NOTE_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const READABLE_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".html", ".htm", ".csv", ".tsv",
  ".json", ".yaml", ".yml", ".log", ".rst",
]);
const MAX_INDEXED_BYTES = 256 * 1024;

// Manifest filenames that have their own dedicated indexers
// (`indexAppManifest` / `indexFragmentManifest`). The generic doc path
// must skip them, otherwise `find_artifacts` returns the same path
// twice — once as `kind=app`/`kind=fragment` and once as `kind=doc`.
const MANIFEST_FILENAMES = new Set(["desk.app.json", "desk.fragment.json"]);

function classifyExt(rel: string): LibraryKind | null {
  const base = path.basename(rel);
  if (MANIFEST_FILENAMES.has(base)) return null;
  const ext = path.extname(rel).toLowerCase();
  if (NOTE_EXTENSIONS.has(ext)) return "note";
  if (READABLE_EXTENSIONS.has(ext)) return "doc";
  return null;
}

async function readLibraryFile(home: string, slug: string, rel: string): Promise<string | null> {
  const abs = path.join(workspaceRootPath(home, slug), rel);
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_INDEXED_BYTES) {
      // Skip very large files. The index would otherwise blow up on a
      // 50MB CSV; the agent can read those directly.
      return null;
    }
    return await fs.readFile(abs, "utf-8");
  } catch {
    return null;
  }
}

function manifestSearchBody(m: AppManifest | FragmentManifest): string {
  const params = m.params
    ? Object.entries(m.params).map(([k, v]) => `${k}=${v}`).join(" ")
    : "";
  const parts = [m.name, m.description, params].filter((p) => p && p.length > 0);
  return parts.join("\n");
}

// Best-effort recovery when a manifest fails strict validation: pluck
// any name/description fields the JSON happens to expose, fall back to
// the directory basename. The hit ends up with empty params_schema —
// not great, but better than the manifest never appearing at all.
function degradedManifestBody(
  raw: unknown,
  fallbackName: string,
): string {
  const obj = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
  const rawName = typeof obj.name === "string" && obj.name.length > 0 ? obj.name : fallbackName;
  const rawDescription = typeof obj.description === "string" ? obj.description : "";
  const parts = [rawName, rawDescription].filter((p) => p && p.length > 0);
  return parts.join("\n");
}

/** Replace any prior index row for `(kind, refId)` with the given body. */
async function upsertIndex(
  pool: Pool,
  kind: LibraryKind,
  refId: string,
  workspaceSlug: string,
  body: string,
  createdAt: string,
): Promise<void> {
  await pool.query(
    `INSERT OR REPLACE INTO chat_search_index
       (ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    [refId, body, body.toLowerCase(), workspaceSlug, kind, createdAt],
  );
}

/** Delete any prior index row for `(kind, refId)`. */
async function deleteIndex(pool: Pool, kind: LibraryKind, refId: string): Promise<void> {
  await pool.query(
    `DELETE FROM chat_search_index WHERE kind = ? AND ref_id = ?`,
    [kind, refId],
  );
}

/**
 * Indexes a single library file by reading its body. `kind` is
 * inferred from the extension; non-text formats are skipped silently.
 */
export async function indexLibraryFile(
  pool: Pool,
  home: string,
  workspaceSlug: string,
  relPath: string,
): Promise<void> {
  const kind = classifyExt(relPath);
  if (!kind) return;
  const body = await readLibraryFile(home, workspaceSlug, relPath);
  if (body === null) return;
  const stat = await fs.stat(path.join(workspaceRootPath(home, workspaceSlug), relPath)).catch(() => null);
  const createdAt = stat ? stat.mtime.toISOString() : new Date().toISOString();
  await upsertIndex(pool, kind, relPath, workspaceSlug, body, createdAt).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("indexLibraryFile failed:", relPath, err);
  });
}

/**
 * Indexes a `desk.app.json` manifest. The body indexed is the
 * concatenation of name + description + serialized params, so all
 * three are matchable via `find_artifacts`.
 */
export async function indexAppManifest(
  pool: Pool,
  home: string,
  workspaceSlug: string,
  appDirRelPath: string,
): Promise<void> {
  const manifestPath = path.join(
    workspaceRootPath(home, workspaceSlug),
    appDirRelPath,
    "desk.app.json",
  );
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf-8");
  } catch {
    return;
  }
  let body: string;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("indexAppManifest: unparseable JSON", appDirRelPath, err);
    parsedJson = null;
  }
  const parseResult = AppManifestSchema.safeParse(parsedJson);
  if (parseResult.success) {
    body = manifestSearchBody(parseResult.data);
  } else {
    // Degraded: still index so the agent can find the manifest by name,
    // even when an extra field or missing description trips validation.
    // eslint-disable-next-line no-console
    console.warn(
      "indexAppManifest: invalid manifest, indexing degraded entry",
      appDirRelPath,
      parseResult.error.issues,
    );
    const fallbackName = appDirRelPath.split("/").pop() || appDirRelPath || "app";
    body = degradedManifestBody(parsedJson, fallbackName);
  }
  const stat = await fs.stat(manifestPath).catch(() => null);
  const createdAt = stat ? stat.mtime.toISOString() : new Date().toISOString();
  await upsertIndex(pool, "app", appDirRelPath, workspaceSlug, body, createdAt);
}

/** Indexes one fragment manifest by its workspace-relative directory. */
export async function indexFragmentManifest(
  pool: Pool,
  home: string,
  workspaceSlug: string,
  fragmentDirRelPath: string,
): Promise<void> {
  const manifestPath = path.join(
    workspaceRootPath(home, workspaceSlug),
    fragmentDirRelPath,
    "desk.fragment.json",
  );
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf-8");
  } catch {
    return;
  }
  let body: string;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("indexFragmentManifest: unparseable JSON", fragmentDirRelPath, err);
    parsedJson = null;
  }
  const parseResult = FragmentManifestSchema.safeParse(parsedJson);
  if (parseResult.success) {
    body = manifestSearchBody(parseResult.data);
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "indexFragmentManifest: invalid manifest, indexing degraded entry",
      fragmentDirRelPath,
      parseResult.error.issues,
    );
    const fallbackName =
      fragmentDirRelPath.split("/").pop() || fragmentDirRelPath || "fragment";
    body = degradedManifestBody(parsedJson, fallbackName);
  }
  const stat = await fs.stat(manifestPath).catch(() => null);
  const createdAt = stat ? stat.mtime.toISOString() : new Date().toISOString();
  await upsertIndex(pool, "fragment", fragmentDirRelPath, workspaceSlug, body, createdAt);
}

/** Removes a single library row from the index. Best-effort. */
export async function unindexLibraryPath(
  pool: Pool,
  relPath: string,
  workspaceSlug?: string,
  kind?: LibraryKind,
): Promise<void> {
  if (kind) {
    if (workspaceSlug) {
      await pool.query(
        `DELETE FROM chat_search_index WHERE kind = ? AND workspace_slug = ? AND ref_id = ?`,
        [kind, workspaceSlug, relPath],
      );
      return;
    }
    await deleteIndex(pool, kind, relPath);
    return;
  }
  if (workspaceSlug) {
    await pool.query(
      `DELETE FROM chat_search_index
       WHERE workspace_slug = ? AND ref_id = ? AND kind IN ('note', 'doc', 'app', 'fragment')`,
      [workspaceSlug, relPath],
    );
    return;
  }
  // Delete across every library kind. Cheap; one row per kind at most.
  await pool.query(
    `DELETE FROM chat_search_index WHERE ref_id = ? AND kind IN ('note', 'doc', 'app', 'fragment')`,
    [relPath],
  );
}

/** Removes index rows for a library path and anything nested under it. */
export async function unindexLibraryTree(
  pool: Pool,
  workspaceSlug: string,
  relPath: string,
): Promise<void> {
  const prefix = relPath.endsWith("/") ? relPath : `${relPath}/`;
  await pool.query(
    `DELETE FROM chat_search_index
     WHERE workspace_slug = ?
       AND kind IN ('note', 'doc', 'app', 'fragment')
       AND (ref_id = ? OR ref_id LIKE ? ESCAPE '\\')`,
    [workspaceSlug, relPath, `${prefix.replace(/[%_\\]/g, "\\$&")}%`],
  );
}

/**
 * Walks `workspaceRoot/<slug>/`, indexing every recognized file and
 * manifest. Idempotent — `INSERT OR REPLACE` overwrites prior rows.
 *
 * Skips:
 *   - Hidden directories (`.chats/`, `.opencode/`, `.memory/`, etc.)
 *   - `node_modules/`
 *   - Files larger than `MAX_INDEXED_BYTES`
 */
export async function backfillWorkspaceLibrary(
  pool: Pool,
  home: string,
  workspaceSlug: string,
): Promise<{ filesIndexed: number; manifestsIndexed: number }> {
  const root = workspaceRootPath(home, workspaceSlug);
  let filesIndexed = 0;
  let manifestsIndexed = 0;

  async function walk(dirAbs: string, dirRel: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }

    // Detect a `<name>.app/` directory by its `desk.app.json`.
    const isAppDir = entries.some(
      (e) => e.isFile() && e.name === "desk.app.json",
    );
    if (isAppDir) {
      await indexAppManifest(pool, home, workspaceSlug, dirRel);
      manifestsIndexed += 1;
    }

    // Detect a fragment directory by its `desk.fragment.json`.
    const isFragmentDir = entries.some(
      (e) => e.isFile() && e.name === "desk.fragment.json",
    );
    if (isFragmentDir) {
      await indexFragmentManifest(pool, home, workspaceSlug, dirRel);
      manifestsIndexed += 1;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const childRel = dirRel ? path.join(dirRel, entry.name) : entry.name;
      const childAbs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        const kind = classifyExt(entry.name);
        if (kind) {
          await indexLibraryFile(pool, home, workspaceSlug, childRel);
          filesIndexed += 1;
        }
      }
    }
  }

  await walk(root, "");
  return { filesIndexed, manifestsIndexed };
}
