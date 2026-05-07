import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import {
  AppManifestSchema,
  FragmentManifestSchema,
  NotFoundError,
  type AppManifest,
  type FragmentManifest,
} from "@agent-desk/shared";
import {
  workspaceRootPath,
  loadGitignoreFrame,
  isGitIgnored,
  type IgnoreFrame,
  type StorageContext,
} from "@agent-desk/storage";

export interface SearchResult {
  type: "file" | "chat" | "message";
  id: string;
  refId?: string;
  title: string;
  snippet?: string;
  workspaceId?: string;
  workspaceSlug?: string;
  chatId?: string;
  messageId?: string;
  kind?: SearchKind;
  score?: number;
}

export interface ArtifactSearchResult {
  kind: "app" | "fragment" | "note" | "doc";
  path: string;
  name: string;
  description: string;
  workspaceSlug: string;
  lastModified: string;
  score: number;
  params_schema?: Record<string, string>;
}

type SearchKind =
  | "chat"
  | "message"
  | "summary"
  | "library_file"
  | "attachment"
  | "artifact";

const FILE_KINDS: SearchKind[] = ["library_file", "attachment", "artifact"];
const CHAT_KINDS: SearchKind[] = ["chat", "message", "summary"];
const INDEXED_TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".html", ".css", ".js", ".jsx",
  ".ts", ".tsx", ".mjs", ".cjs", ".yml", ".yaml", ".csv", ".xml", ".svg",
  ".url", ".webloc", ".desktop",
]);
const EXCLUDED_INDEX_SEGMENTS = new Set([".git", ".storage", ".trash", "node_modules", "dist", "build"]);
const MAX_INDEXED_FILE_BYTES = 128 * 1024;

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
  opts: { showHidden: boolean; includeChats?: boolean },
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
    if (!opts.showHidden && e.name.startsWith(".") && !(opts.includeChats && e.name === ".chats")) continue;
    const abs = path.join(root, e.name);
    const isDir = e.isDirectory();
    if (respectGitignore && !(opts.includeChats && e.name === ".chats") && isGitIgnored(abs, isDir, seeded)) continue;
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

function isSafeIndexedTextPath(relPath: string): boolean {
  const segments = relPath.split("/");
  if (segments.some((segment) => EXCLUDED_INDEX_SEGMENTS.has(segment))) return false;
  return INDEXED_TEXT_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

function encodeFileRef(workspaceSlug: string, relPath: string): string {
  return `${workspaceSlug}::${relPath}`;
}

function decodeFileRef(workspaceSlug: string, refId: string): string {
  const prefix = `${workspaceSlug}::`;
  return refId.startsWith(prefix) ? refId.slice(prefix.length) : refId;
}

function classifyFileKind(relPath: string): { kind: SearchKind; chatId: string | null } | null {
  const segments = relPath.split("/");
  if (segments[0] === ".chats") {
    const chatId = segments[1] ?? null;
    if (segments[2] === "attachments") return { kind: "attachment", chatId };
    if (segments[2] === "artifacts") return { kind: "artifact", chatId };
    return null;
  }
  return { kind: "library_file", chatId: null };
}

function artifactKindForPath(relPath: string): ArtifactSearchResult["kind"] {
  if (relPath.endsWith("/desk.app.json")) return "app";
  if (relPath.endsWith("/desk.fragment.json")) return "fragment";
  const ext = path.extname(relPath).toLowerCase();
  return ext === ".md" || ext === ".markdown" || ext === ".txt" ? "note" : "doc";
}

function artifactPathForFile(relPath: string, kind: ArtifactSearchResult["kind"]): string {
  if (kind === "app") return path.posix.dirname(relPath);
  if (kind === "fragment") {
    const fragmentDir = path.posix.dirname(relPath);
    const appFragmentsDir = "/fragments/";
    const markerIndex = fragmentDir.indexOf(appFragmentsDir);
    if (markerIndex === -1) return fragmentDir;
    const appDir = fragmentDir.slice(0, markerIndex);
    const fragmentName = fragmentDir.slice(markerIndex + appFragmentsDir.length);
    return `${appDir}/dist/fragments/${fragmentName}`;
  }
  return relPath;
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/, 1)[0] ?? "").trim();
}

async function readTextFile(abs: string): Promise<string> {
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isFile() || stat.size > MAX_INDEXED_FILE_BYTES) return "";
  const buf = await fs.readFile(abs).catch(() => null);
  if (!buf || buf.includes(0)) return "";
  return buf.toString("utf-8");
}

async function readManifest(abs: string, kind: "app" | "fragment"): Promise<AppManifest | FragmentManifest | null> {
  const raw = await readTextFile(abs);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return kind === "app" ? AppManifestSchema.parse(parsed) : FragmentManifestSchema.parse(parsed);
  } catch {
    return null;
  }
}

async function artifactResultFromHit(
  storage: StorageContext,
  hit: Awaited<ReturnType<typeof queries.search.searchChatMessages>>[number],
): Promise<ArtifactSearchResult | null> {
  if (!hit.workspaceSlug || hit.kind !== "library_file") return null;
  const relPath = decodeFileRef(hit.workspaceSlug, hit.refId);
  const kind = artifactKindForPath(relPath);
  const artifactPath = artifactPathForFile(relPath, kind);
  const root = workspaceRootPath(storage.home, hit.workspaceSlug);
  const abs = path.join(root, relPath);

  if (kind === "app" || kind === "fragment") {
    const manifest = await readManifest(abs, kind);
    const fallbackName = path.basename(artifactPath).replace(/\.app$/, "");
    return {
      kind,
      path: artifactPath,
      name: manifest?.name ?? fallbackName,
      description: manifest?.description ?? "",
      workspaceSlug: hit.workspaceSlug,
      lastModified: hit.createdAt,
      score: hit.score,
      ...(manifest?.params ? { params_schema: manifest.params } : {}),
    };
  }

  const body = await readTextFile(abs);
  return {
    kind,
    path: artifactPath,
    name: path.basename(relPath),
    description: firstLine(body),
    workspaceSlug: hit.workspaceSlug,
    lastModified: hit.createdAt,
    score: hit.score,
  };
}

async function searchableBodyForFile(abs: string, relPath: string): Promise<string | null> {
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  if (stat.size > MAX_INDEXED_FILE_BYTES) return relPath;
  if (!isSafeIndexedTextPath(relPath)) return relPath;
  const buf = await fs.readFile(abs).catch(() => null);
  if (!buf) return relPath;
  if (buf.includes(0)) return relPath;
  const text = buf.toString("utf-8");
  const replacementCount = (text.match(/\uFFFD/g) ?? []).length;
  if (replacementCount > Math.max(8, text.length / 100)) return relPath;
  return `${relPath}\n${text}`;
}

async function refreshWorkspaceFileIndex(
  pool: Pool,
  storage: StorageContext,
  workspaceSlug: string,
  opts: { showHidden: boolean },
): Promise<void> {
  const root = workspaceRootPath(storage.home, workspaceSlug);
  const files = await walkFiles(root, { showHidden: opts.showHidden, includeChats: true });
  await queries.search.deleteSearchDocumentsForWorkspace(pool, workspaceSlug, FILE_KINDS);
  for (const file of files) {
    const rel = path.relative(root, file.abs).split(path.sep).join("/");
    const classified = classifyFileKind(rel);
    if (!classified) continue;
    const body = await searchableBodyForFile(file.abs, rel);
    if (!body) continue;
    const stat = await fs.stat(file.abs).catch(() => null);
    await queries.search.upsertSearchDocument(pool, {
      refId: encodeFileRef(workspaceSlug, rel),
      body,
      chatId: classified.chatId,
      workspaceSlug,
      kind: classified.kind,
      createdAt: stat?.mtime.toISOString(),
    });
  }
}

function kindsForScope(scope: "artifacts" | "chats" | "library" | "all" | "files"): SearchKind[] {
  switch (scope) {
    case "chats": return CHAT_KINDS;
    case "library": return ["library_file"];
    case "artifacts": return ["attachment", "artifact"];
    case "files": return FILE_KINDS;
    case "all": return [...CHAT_KINDS, ...FILE_KINDS];
  }
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
  userId: string,
  query: string,
  scope: "artifacts" | "chats" | "library" | "all" | "files" = "all",
  opts?: { showHidden?: boolean; workspaceId?: string; chatId?: string; kinds?: SearchKind[] },
): Promise<SearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const showHidden = opts?.showHidden ?? false;
  const workspaceId = opts?.workspaceId;

  // Filesystem scopes need a concrete workspace slug. When workspaceId is
  // omitted we fall back to the full set so single-workspace callers (and
  // tests) still get results — multi-workspace callers should always scope.
  const workspaces = workspaceId
    ? await queries.workspaces.findById(pool, workspaceId).then((w) => {
        if (!w || w.userId !== userId) throw new NotFoundError(`Workspace not found: ${workspaceId}`);
        return [w];
      })
    : await queries.workspaces.listByUser(pool, userId);

  const selectedKinds = opts?.kinds && opts.kinds.length > 0 ? opts.kinds : kindsForScope(scope);
  // Explicit file scopes refresh the on-disk index synchronously. The default
  // global search path must stay responsive while users type, so it searches
  // whatever file rows are already indexed and never blocks chat/title results
  // on a full workspace walk.
  if (scope !== "all" && selectedKinds.some((kind) => FILE_KINDS.includes(kind))) {
    for (const ws of workspaces) await refreshWorkspaceFileIndex(pool, storage, ws.path, { showHidden });
  }

  const workspaceBySlug = new Map(workspaces.map((ws) => [ws.path, ws]));
  const hits = await queries.search.searchChatMessages(pool, {
    query: trimmedQuery,
    chatId: opts?.chatId,
    workspaceSlugs: workspaces.map((ws) => ws.path),
    kinds: selectedKinds,
    limit: 40,
  });
  const chatIds = [...new Set(hits.map((hit) => hit.chatId).filter((id): id is string => Boolean(id)))];
  const titleByChatId = new Map<string, string>();
  if (chatIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT id, title FROM chats WHERE id IN (${chatIds.map(() => "?").join(", ")})`,
      chatIds,
    );
    for (const row of rows) titleByChatId.set(row.id as string, row.title as string);
  }

  return hits.flatMap((hit): SearchResult[] => {
    if (!hit.workspaceSlug) return [];
    const ws = workspaceBySlug.get(hit.workspaceSlug);
    if (!ws) return [];
    if (hit.kind === "chat" || hit.kind === "message" || hit.kind === "summary") {
      if (!hit.chatId) return [];
      return [{
        type: hit.kind === "chat" ? "chat" : "message",
        id: hit.chatId,
        refId: hit.refId,
        title: titleByChatId.get(hit.chatId) ?? "Chat message",
        snippet: hit.snippet,
        workspaceId: ws.id,
        workspaceSlug: ws.path,
        chatId: hit.chatId,
        messageId: hit.kind === "chat" ? undefined : hit.refId,
        kind: hit.kind,
        score: hit.score,
      }];
    }
    return [{
      type: "file",
      id: decodeFileRef(hit.workspaceSlug, hit.refId),
      refId: hit.refId,
      title: path.basename(decodeFileRef(hit.workspaceSlug, hit.refId)),
      snippet: hit.snippet,
      workspaceId: ws.id,
      workspaceSlug: ws.path,
      chatId: hit.chatId ?? undefined,
      kind: hit.kind,
      score: hit.score,
    }];
  }).slice(0, 40);
}

export async function findArtifacts(
  pool: Pool,
  storage: StorageContext,
  userId: string,
  opts: {
    query?: string;
    kind?: ArtifactSearchResult["kind"] | "any";
    workspaceId?: string;
    limit?: number;
  } = {},
): Promise<ArtifactSearchResult[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  const query = opts.query?.trim() ?? "";
  const workspaces = opts.workspaceId
    ? await queries.workspaces.findById(pool, opts.workspaceId).then((w) => {
        if (!w || w.userId !== userId) throw new NotFoundError(`Workspace not found: ${opts.workspaceId}`);
        return [w];
      })
    : await queries.workspaces.listByUser(pool, userId);

  for (const ws of workspaces) await refreshWorkspaceFileIndex(pool, storage, ws.path, { showHidden: false });

  const workspaceSlugs = workspaces.map((ws) => ws.path);
  const rawLimit = Math.min(500, Math.max(limit * 20, 100));
  const rawHits = query
    ? await queries.search.searchChatMessages(pool, {
        query,
        workspaceSlugs,
        kinds: ["library_file"],
        limit: rawLimit,
      })
    : await queries.search.listSearchDocuments(pool, {
        workspaceSlugs,
        kinds: ["library_file"],
        limit: rawLimit,
      });

  const wantedKind = opts.kind && opts.kind !== "any" ? opts.kind : null;
  const seen = new Set<string>();
  const results: ArtifactSearchResult[] = [];
  for (const hit of rawHits) {
    const result = await artifactResultFromHit(storage, hit);
    if (!result) continue;
    if (wantedKind && result.kind !== wantedKind) continue;
    const key = `${result.workspaceSlug}:${result.kind}:${result.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(result);
  }

  results.sort((a, b) => b.score - a.score || (a.lastModified < b.lastModified ? 1 : -1));
  return results.slice(0, limit);
}
