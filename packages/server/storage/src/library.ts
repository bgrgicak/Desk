import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { type Pool } from "@agent-desk/db";
import ignore, { type Ignore } from "ignore";
import { NotFoundError, ValidationError } from "@agent-desk/shared";
import {
  workspaceRootPath,
  trashDir,
  resolveHostPath,
  chatsDir,
  type VirtualLibraryMount,
} from "./layout.js";
import {
  uploadArtifact,
  relativeSymlinkTarget,
  uniqueDestPath,
  validateLibrarySubpath,
  type FileRef,
  type StorageContext,
} from "./files.js";
import {
  invalidateLibraryListCache,
  type ListLibraryRaw,
} from "./library-cache.js";

/**
 * Cap for `searchLibrary` — keeps the wire payload bounded even when a
 * one-character query matches half the workspace. Tuned for the global
 * palette + @-mention pickers, which only render the top N anyway.
 */
const SEARCH_RESULT_CAP = 200;

export { invalidateLibraryListCache } from "./library-cache.js";

export interface LibraryContext {
  pool: Pool;
  home: string;
}

/**
 * Minimal metadata for a folder (directory) inside the workspace.
 * Returned alongside `FileRef` items from `listLibrary` so the client can
 * render an accurate hierarchy — including empty folders, which wouldn't
 * appear if it only derived structure from file paths.
 */
export interface FolderRef {
  /** Workspace-root-relative path, e.g. `Projects/Q2`. */
  path: string;
  /** The folder's basename. */
  name: string;
  /** ISO mtime. */
  createdAt: string;
  /** True when the folder is pinned (mirrors FileRef.pinned). The route
   *  layer fills this in from library_pins; storage leaves it unset. */
  pinned?: boolean;
}

export type { VirtualLibraryMount } from "./layout.js";

/**
 * Runs `fn` over `items` with at most `limit` calls in flight. Results
 * are returned in input order. Used to parallelize fs.stat batches in
 * listLibrary without unleashing thousands of concurrent syscalls.
 */
async function pMap<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

const STAT_CONCURRENCY = 64;

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
    // URL-shortcut formats. `.url` (Windows INI) and `.webloc` (macOS
    // plist) are unambiguous link formats. `.desktop` is ambiguous on
    // Linux (also used for app launchers), but inside a user library
    // the overwhelming case is a paste-link entry, so we tag it as a
    // link and accept the rare misclassification.
    case ".url": case ".webloc": case ".desktop": return "text/uri-list";
    default: return "application/octet-stream";
  }
}

export interface IgnoreFrame {
  /** Absolute directory the gitignore rules are anchored to. */
  dir: string;
  ig: Ignore;
}

/**
 * Reads `dir/.gitignore` if present and returns a frame anchoring its
 * rules to `dir`. Returns null when the file doesn't exist — the caller
 * just inherits ancestor frames in that case.
 */
export async function loadGitignoreFrame(dir: string): Promise<IgnoreFrame | null> {
  const body = await fs.readFile(path.join(dir, ".gitignore"), "utf-8").catch(() => null);
  if (body === null) return null;
  return { dir, ig: ignore().add(body) };
}

/**
 * Returns true if any ancestor `.gitignore` ignores this entry. Each
 * frame's rules are tested with the path *relative to that frame's
 * directory* (and a trailing slash for directories), matching how git
 * itself scopes nested gitignores.
 */
export function isGitIgnored(entryAbs: string, isDir: boolean, frames: IgnoreFrame[]): boolean {
  for (const frame of frames) {
    const rel = path.relative(frame.dir, entryAbs).split(path.sep).join("/");
    if (!rel || rel.startsWith("../")) continue;
    if (frame.ig.ignores(isDir ? `${rel}/` : rel)) return true;
  }
  return false;
}

/**
 * Recursively walks `dir`, collecting files and subdirectories. Both lists
 * are returned as absolute paths for the caller to project into
 * workspace-relative form.
 *
 * Visibility rules — both apply only when `showHidden` is false (default):
 *   1. Dot-prefixed entries are skipped at every level so agent
 *      infrastructure like `.chats/` stays invisible.
 *   2. `.gitignore` rules are honoured. Each directory's gitignore is
 *      composed with its ancestors', so a root-level `node_modules/` rule
 *      hides the whole subtree and a nested `build/` rule only hides that
 *      subtree's build dir — exactly mirroring git's own scoping.
 *
 * Symlinks are listed as their resolved kind (file or folder) but never
 * recursed through. That matches `ls` semantics, surfaces npm-style
 * workspace links (`node_modules/@scope/pkg → ../../packages/pkg`), and
 * avoids both cycles and duplicate entries when the link target already
 * sits inside the walked tree.
 */
function isAppDirectoryName(name: string): boolean {
  return name.endsWith(".app") && name !== ".app";
}

async function walk(
  dir: string,
  opts: { showHidden: boolean; recurse?: boolean; ancestorFrames?: IgnoreFrame[] },
): Promise<{ files: string[]; folders: string[]; appDirs: string[] }> {
  const files: string[] = [];
  const folders: string[] = [];
  // `<name>.app/` directories are collapsed into a single library
  // entry rather than expanded; the walker tracks them separately so
  // listLibrary can stat + emit them as `isDir: true` items without
  // ever recursing into the dist/ + node_modules/ underneath.
  const appDirs: string[] = [];
  const respectGitignore = !opts.showHidden;
  const recurse = opts.recurse !== false;

  const rootFrame = respectGitignore ? await loadGitignoreFrame(dir) : null;
  const seedFrames: IgnoreFrame[] = [
    ...(opts.ancestorFrames ?? []),
    ...(rootFrame ? [rootFrame] : []),
  ];
  const stack: Array<{ abs: string; frames: IgnoreFrame[] }> = [
    { abs: dir, frames: seedFrames },
  ];

  while (stack.length > 0) {
    const { abs: current, frames } = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!opts.showHidden && e.name.startsWith(".")) continue;
      const abs = path.join(current, e.name);

      let kind: "dir" | "file" | null = null;
      let isRealDir = false;
      if (e.isDirectory()) {
        kind = "dir";
        isRealDir = true;
      } else if (e.isFile()) {
        kind = "file";
      } else if (e.isSymbolicLink()) {
        const target = await fs.stat(abs).catch(() => null);
        if (!target) continue;
        if (target.isDirectory()) kind = "dir";
        else if (target.isFile()) kind = "file";
        else continue;
      }
      if (!kind) continue;

      if (respectGitignore && isGitIgnored(abs, kind === "dir", frames)) continue;

      if (kind === "dir") {
        if (isAppDirectoryName(e.name)) {
          // Collapse `<name>.app/` into a single library entry — don't
          // recurse, don't add to the navigable folder list.
          appDirs.push(abs);
          continue;
        }
        folders.push(abs);
        if (recurse && isRealDir) {
          const childFrame = respectGitignore ? await loadGitignoreFrame(abs) : null;
          const childFrames = childFrame ? [...frames, childFrame] : frames;
          stack.push({ abs, frames: childFrames });
        }
      } else {
        files.push(abs);
      }
    }
  }

  return { files, folders, appDirs };
}

const APP_DIR_MIME = "application/vnd.desk.app+directory";

/**
 * Resolves a workspace-root-relative path to the actual on-disk directory
 * to walk. Empty path → the workspace root. A path whose first segment
 * matches a virtual mount's `homeName` → the mount's source path (plus
 * any deeper segments). Otherwise the path is resolved under the
 * workspace root. Throws if the resolved target sits outside both the
 * workspace root and any virtual mount source.
 */
function resolveListPath(
  ctx: LibraryContext,
  slug: string,
  relPath: string,
  virtualMounts: VirtualLibraryMount[],
): { abs: string; relPrefix: string } {
  const sub = validateLibrarySubpath(relPath);
  if (sub === "") {
    return { abs: workspaceRootPath(ctx.home, slug), relPrefix: "" };
  }
  const segments = sub.split("/");
  const head = segments[0];
  const mount = virtualMounts.find((m) => m.homeName === head);
  if (mount) {
    const rest = segments.slice(1).join("/");
    const abs = rest
      ? path.resolve(mount.sourcePath, rest)
      : mount.sourcePath;
    const withSep = mount.sourcePath.endsWith(path.sep) ? mount.sourcePath : mount.sourcePath + path.sep;
    if (abs !== mount.sourcePath && !abs.startsWith(withSep)) {
      throw new ValidationError(`Path traversal detected: ${relPath}`);
    }
    return { abs, relPrefix: sub };
  }
  const root = workspaceRootPath(ctx.home, slug);
  return { abs: path.join(root, sub), relPrefix: sub };
}

/**
 * Lists the workspace's library files and folders for a single directory
 * level — does NOT recurse into subfolders. The folder to list is given
 * by `path` (workspace-root-relative); the workspace root itself is the
 * default. Use {@link listLibraryFolders} when you need the full folder
 * tree and {@link searchLibrary} for recursive name matching.
 *
 * Hidden by default and surfaced together when `showHidden` is set:
 *   - dot-prefixed entries (agent infrastructure, OS/editor cruft);
 *   - entries matched by `.gitignore` rules in the target directory and
 *     any ancestor (frames composed in walk-order, mirroring git).
 *
 * Connected local-filesystem mounts surface as top-level entries when
 * listing the root and resolve transparently when the caller drills into
 * `~/{homeName}/...` paths.
 */
export async function listLibrary(
  ctx: LibraryContext,
  slug: string,
  opts?: {
    path?: string;
    showHidden?: boolean;
    virtualMounts?: VirtualLibraryMount[];
  },
): Promise<{ items: FileRef[]; folders: FolderRef[] }> {
  const showHidden = opts?.showHidden ?? false;
  const virtualMounts = opts?.virtualMounts ?? [];
  const targetRel = opts?.path ?? "";

  const root = workspaceRootPath(ctx.home, slug);
  await fs.mkdir(root, { recursive: true });

  const { abs: targetAbs, relPrefix } = resolveListPath(ctx, slug, targetRel, virtualMounts);
  // Only the workspace root is auto-created. Sub-paths that don't exist
  // resolve to an empty listing — silently creating them on read would
  // leave breadcrumbs from stale URLs and turn typos into real folders.

  // Compose ancestor .gitignore frames so a sub-folder listing still
  // honours rules anchored above it (root-level `*.log`, parent-level
  // `private/`, etc.). Mounts root their gitignore composition at the
  // mount source — workspace ancestors don't see the host filesystem.
  let ancestorFrames: IgnoreFrame[] = [];
  if (!showHidden && relPrefix) {
    const segments = relPrefix.split("/");
    const mount = virtualMounts.find((m) => segments[0] === m.homeName);
    if (mount) {
      const inside = segments.slice(1);
      let dir = mount.sourcePath;
      const fr = await loadGitignoreFrame(dir);
      if (fr) ancestorFrames.push(fr);
      for (let i = 0; i < inside.length - 1; i++) {
        dir = path.join(dir, inside[i]);
        const f = await loadGitignoreFrame(dir);
        if (f) ancestorFrames.push(f);
      }
    } else {
      let dir = root;
      const fr = await loadGitignoreFrame(dir);
      if (fr) ancestorFrames.push(fr);
      for (let i = 0; i < segments.length - 1; i++) {
        dir = path.join(dir, segments[i]);
        const f = await loadGitignoreFrame(dir);
        if (f) ancestorFrames.push(f);
      }
    }
  }

  const raw = await walkAndStatLevel(targetAbs, relPrefix, showHidden, ancestorFrames);

  // Project virtual mounts as top-level folder entries when listing the
  // workspace root — they don't exist on disk under the workspace tree
  // but the user expects to see `~/Downloads`, etc., alongside their
  // workspace contents.
  if (targetRel === "" && virtualMounts.length > 0) {
    const existing = new Set(raw.folderItems.map((f) => f.path));
    const mountEntries = await Promise.all(
      virtualMounts.map(async (mount) => {
        if (existing.has(mount.homeName)) return null;
        const homeName = path.basename(mount.homeName);
        if (!homeName || homeName === "." || homeName === "..") return null;
        const stat = await fs.stat(mount.sourcePath).catch(() => null);
        if (!stat?.isDirectory()) return null;
        return {
          path: mount.homeName,
          name: homeName,
          createdAt: stat.mtime.toISOString(),
        } as FolderRef;
      }),
    );
    for (const f of mountEntries) {
      if (f) raw.folderItems.push(f);
    }
    raw.folderItems.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  return { items: raw.fileItems, folders: raw.folderItems };
}

/**
 * Single-level (non-recursive) walk + stat for the directory at `targetAbs`.
 * `relPrefix` is the workspace-root-relative path of the directory, used
 * to compute child paths. Returns FileRef/FolderRef shapes ready to ship.
 */
async function walkAndStatLevel(
  targetAbs: string,
  relPrefix: string,
  showHidden: boolean,
  ancestorFrames: IgnoreFrame[] = [],
): Promise<ListLibraryRaw> {
  const { files, folders, appDirs } = await walk(targetAbs, {
    showHidden,
    recurse: false,
    ancestorFrames,
  });

  const toRel = (abs: string): string => {
    const child = path.basename(abs);
    return relPrefix ? `${relPrefix}/${child}` : child;
  };
  const fileEntries = files.map((abs) => ({ abs, rel: toRel(abs) }));
  const folderEntries = folders.map((abs) => ({ abs, rel: toRel(abs) }));
  const appDirEntriesInput = appDirs.map((abs) => ({ abs, rel: toRel(abs) }));

  const [fileStats, folderStats, appDirMeta] = await Promise.all([
    pMap(fileEntries, STAT_CONCURRENCY, async (e) => ({ e, stat: await fs.stat(e.abs).catch(() => null) })),
    pMap(folderEntries, STAT_CONCURRENCY, async (e) => ({ e, stat: await fs.stat(e.abs).catch(() => null) })),
    pMap(appDirEntriesInput, STAT_CONCURRENCY, async (e) => ({
      e,
      isSymlink: (await fs.lstat(e.abs).catch(() => null))?.isSymbolicLink() ?? false,
      realPath: await fs.realpath(e.abs).catch(() => e.abs),
    })),
  ]);

  const fileItems: FileRef[] = [];
  const seenFilePaths = new Set<string>();
  for (const { e, stat } of fileStats) {
    if (!stat) continue;
    const name = path.basename(e.abs);
    const isAppDir = stat.isDirectory() && name.endsWith(".app") && name !== ".app";
    if (!stat.isFile() && !isAppDir) continue;
    if (seenFilePaths.has(e.rel)) continue;
    seenFilePaths.add(e.rel);
    fileItems.push({
      path: e.rel,
      name,
      mime: isAppDir ? "inode/directory" : guessMime(e.abs),
      size: isAppDir ? 0 : stat.size,
      createdAt: stat.mtime.toISOString(),
      updatedAtMs: String(stat.mtimeMs),
      isDir: isAppDir || undefined,
    });
  }

  appDirMeta.sort((a, b) => Number(a.isSymlink) - Number(b.isSymlink));
  const appDirStats = await pMap(appDirMeta, STAT_CONCURRENCY, async (m) => ({
    ...m,
    stat: await fs.stat(m.e.abs).catch(() => null),
  }));
  const seenAppRealPaths = new Set<string>();
  for (const { e, realPath, stat } of appDirStats) {
    if (seenAppRealPaths.has(realPath)) continue;
    seenAppRealPaths.add(realPath);
    if (!stat || !stat.isDirectory()) continue;
    if (seenFilePaths.has(e.rel)) continue;
    seenFilePaths.add(e.rel);
    fileItems.push({
      path: e.rel,
      name: path.basename(e.abs),
      mime: APP_DIR_MIME,
      size: 0,
      createdAt: stat.mtime.toISOString(),
      updatedAtMs: String(stat.mtimeMs),
      isDir: true,
    });
  }
  fileItems.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const folderItems: FolderRef[] = [];
  const seenFolderPaths = new Set<string>();
  for (const { e, stat } of folderStats) {
    if (!stat || !stat.isDirectory()) continue;
    if (seenFolderPaths.has(e.rel)) continue;
    seenFolderPaths.add(e.rel);
    folderItems.push({
      path: e.rel,
      name: path.basename(e.abs),
      createdAt: stat.mtime.toISOString(),
    });
  }
  folderItems.sort((a, b) => (a.path < b.path ? -1 : 1));

  return { fileItems, folderItems };
}

/**
 * Returns every folder in the workspace tree as a flat FolderRef[].
 * Cheap because it skips file stats entirely — used by the move-to-folder
 * picker, breadcrumb resolver, and pinned-sidebar (folder-pin lookups).
 *
 * Honours the same hidden-entry + gitignore rules as {@link listLibrary}.
 */
export async function listLibraryFolders(
  ctx: LibraryContext,
  slug: string,
  opts?: { showHidden?: boolean; virtualMounts?: VirtualLibraryMount[] },
): Promise<{ folders: FolderRef[] }> {
  const showHidden = opts?.showHidden ?? false;
  const virtualMounts = opts?.virtualMounts ?? [];

  const root = workspaceRootPath(ctx.home, slug);
  await fs.mkdir(root, { recursive: true });

  const { folders } = await walk(root, { showHidden, recurse: true });
  const folderEntries = folders.map((abs) => ({
    abs,
    rel: path.relative(root, abs).split(path.sep).join("/"),
  }));

  for (const mount of virtualMounts) {
    const sourceStat = await fs.stat(mount.sourcePath).catch(() => null);
    if (!sourceStat?.isDirectory()) continue;
    const homeName = path.basename(mount.homeName);
    if (!homeName || homeName === "." || homeName === "..") continue;
    folderEntries.push({ abs: mount.sourcePath, rel: mount.homeName });
    const mounted = await walk(mount.sourcePath, { showHidden, recurse: true });
    for (const abs of mounted.folders) {
      const childRel = path.relative(mount.sourcePath, abs).split(path.sep).join("/");
      folderEntries.push({ abs, rel: `${mount.homeName}/${childRel}` });
    }
  }

  const stats = await pMap(folderEntries, STAT_CONCURRENCY, async (e) => ({
    e,
    stat: await fs.stat(e.abs).catch(() => null),
  }));
  const seen = new Set<string>();
  const items: FolderRef[] = [];
  for (const { e, stat } of stats) {
    if (!stat || !stat.isDirectory()) continue;
    if (seen.has(e.rel)) continue;
    seen.add(e.rel);
    items.push({
      path: e.rel,
      name: path.basename(e.abs),
      createdAt: stat.mtime.toISOString(),
    });
  }
  items.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { folders: items };
}

/**
 * Capped recursive name search across the workspace. Matches when the
 * basename or any path segment contains `q` (case-insensitive). Cap is
 * {@link SEARCH_RESULT_CAP} — `truncated: true` signals the caller's UI
 * should prompt for a more specific query rather than silently dropping
 * results.
 */
export async function searchLibrary(
  ctx: LibraryContext,
  slug: string,
  opts: { q: string; showHidden?: boolean; virtualMounts?: VirtualLibraryMount[]; limit?: number },
): Promise<{ items: FileRef[]; folders: FolderRef[]; truncated: boolean }> {
  const query = opts.q.trim().toLowerCase();
  if (!query) return { items: [], folders: [], truncated: false };
  const cap = Math.max(1, Math.min(opts.limit ?? SEARCH_RESULT_CAP, SEARCH_RESULT_CAP));

  // Reuse the recursive walk + stat pipeline. The result is filtered, not
  // paginated — same cost as the legacy whole-tree listing but the wire
  // payload stays bounded by `cap`.
  const raw = await walkAndStat(ctx, slug, opts.showHidden ?? false, opts.virtualMounts ?? []);

  const matches = (s: string): boolean => s.toLowerCase().includes(query);
  const items: FileRef[] = [];
  for (const f of raw.fileItems) {
    if (matches(f.name) || matches(f.path)) items.push(f);
    if (items.length >= cap) break;
  }
  const folders: FolderRef[] = [];
  if (items.length < cap) {
    for (const f of raw.folderItems) {
      if (matches(f.name) || matches(f.path)) folders.push(f);
      if (items.length + folders.length >= cap) break;
    }
  }
  return {
    items,
    folders,
    truncated: items.length + folders.length >= cap,
  };
}

/**
 * Stats each path in `paths` (workspace-root-relative) and bucketizes the
 * results into FileRef / FolderRef. Missing entries are silently
 * dropped — pins outliving their target are a known case (file moved or
 * deleted out-of-band). The caller is responsible for filtering by
 * caller-supplied workspace access.
 */
export async function statPinnedEntries(
  ctx: LibraryContext,
  slug: string,
  paths: readonly string[],
  virtualMounts: VirtualLibraryMount[] = [],
): Promise<{ items: FileRef[]; folders: FolderRef[] }> {
  if (paths.length === 0) return { items: [], folders: [] };
  const resolved = paths.map((rel) => {
    try {
      const { abs } = resolveListPath(ctx, slug, rel, virtualMounts);
      return { rel, abs };
    } catch {
      return null;
    }
  }).filter((x): x is { rel: string; abs: string } => x !== null);

  const stats = await pMap(resolved, STAT_CONCURRENCY, async (e) => ({
    ...e,
    stat: await fs.stat(e.abs).catch(() => null),
  }));

  const items: FileRef[] = [];
  const folders: FolderRef[] = [];
  for (const { rel, abs, stat } of stats) {
    if (!stat) continue;
    const name = path.basename(abs) || rel;
    if (stat.isDirectory()) {
      const isApp = name.endsWith(".app") && name !== ".app";
      if (isApp) {
        items.push({
          path: rel,
          name,
          mime: APP_DIR_MIME,
          size: 0,
          createdAt: stat.mtime.toISOString(),
          updatedAtMs: String(stat.mtimeMs),
          isDir: true,
          pinned: true,
        });
      } else {
        folders.push({
          path: rel,
          name,
          createdAt: stat.mtime.toISOString(),
          pinned: true,
        });
      }
    } else if (stat.isFile()) {
      items.push({
        path: rel,
        name,
        mime: guessMime(name),
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
        updatedAtMs: String(stat.mtimeMs),
        pinned: true,
      });
    }
  }
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  folders.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { items, folders };
}

async function walkAndStat(
  ctx: LibraryContext,
  slug: string,
  showHidden: boolean,
  virtualMounts: VirtualLibraryMount[],
): Promise<ListLibraryRaw> {
  const root = workspaceRootPath(ctx.home, slug);

  const { files, folders, appDirs } = await walk(root, { showHidden });

  const fileEntries = files.map((abs) => ({ abs, rel: path.relative(root, abs).split(path.sep).join("/") }));
  const folderEntries = folders.map((abs) => ({ abs, rel: path.relative(root, abs).split(path.sep).join("/") }));
  const appDirEntriesInput = appDirs.map((abs) => ({ abs, rel: path.relative(root, abs).split(path.sep).join("/") }));

  // Local filesystem connections are Docker-mounted into the sandbox, so the
  // host-side workspace tree contains only a tiny mount placeholder (or, before
  // the first sandbox starts, no directory at all). The Library API runs on the
  // host, not inside the sandbox, so it has to project those approved host
  // directories into the listing explicitly for the UI to match what agents see
  // at `~/{homeName}`.
  const mountWalks = await Promise.all(
    virtualMounts.map(async (mount) => {
      const sourceStat = await fs.stat(mount.sourcePath).catch(() => null);
      if (!sourceStat?.isDirectory()) return null;
      const homeName = path.basename(mount.homeName);
      if (!homeName || homeName === "." || homeName === "..") return null;
      const mounted = await walk(mount.sourcePath, { showHidden });
      return { mount, homeName, mounted };
    }),
  );
  for (const m of mountWalks) {
    if (!m) continue;
    folderEntries.push({ abs: m.mount.sourcePath, rel: m.homeName });
    for (const abs of m.mounted.files) {
      const childRel = path.relative(m.mount.sourcePath, abs).split(path.sep).join("/");
      fileEntries.push({ abs, rel: `${m.homeName}/${childRel}` });
    }
    for (const abs of m.mounted.folders) {
      const childRel = path.relative(m.mount.sourcePath, abs).split(path.sep).join("/");
      folderEntries.push({ abs, rel: `${m.homeName}/${childRel}` });
    }
    for (const abs of m.mounted.appDirs) {
      const childRel = path.relative(m.mount.sourcePath, abs).split(path.sep).join("/");
      appDirEntriesInput.push({ abs, rel: `${m.homeName}/${childRel}` });
    }
  }

  // Stat all three entry kinds in parallel (bounded concurrency), then
  // iterate the resolved results sequentially to preserve dedup order.
  const [fileStats, folderStats, appDirMeta] = await Promise.all([
    pMap(fileEntries, STAT_CONCURRENCY, async (e) => ({ e, stat: await fs.stat(e.abs).catch(() => null) })),
    pMap(folderEntries, STAT_CONCURRENCY, async (e) => ({ e, stat: await fs.stat(e.abs).catch(() => null) })),
    pMap(appDirEntriesInput, STAT_CONCURRENCY, async (e) => ({
      e,
      isSymlink: (await fs.lstat(e.abs).catch(() => null))?.isSymbolicLink() ?? false,
      realPath: await fs.realpath(e.abs).catch(() => e.abs),
    })),
  ]);

  const fileItems: FileRef[] = [];
  const seenFilePaths = new Set<string>();
  for (const { e, stat } of fileStats) {
    if (!stat) continue;
    const name = path.basename(e.abs);
    const isAppDir = stat.isDirectory() && name.endsWith(".app") && name !== ".app";
    if (!stat.isFile() && !isAppDir) continue;
    if (seenFilePaths.has(e.rel)) continue;
    seenFilePaths.add(e.rel);
    fileItems.push({
      path: e.rel,
      name,
      mime: isAppDir ? "inode/directory" : guessMime(e.abs),
      size: isAppDir ? 0 : stat.size,
      createdAt: stat.mtime.toISOString(),
      updatedAtMs: String(stat.mtimeMs),
      isDir: isAppDir || undefined,
    });
  }

  appDirMeta.sort((a, b) => Number(a.isSymlink) - Number(b.isSymlink));
  const appDirStats = await pMap(appDirMeta, STAT_CONCURRENCY, async (m) => ({
    ...m,
    stat: await fs.stat(m.e.abs).catch(() => null),
  }));
  const seenAppRealPaths = new Set<string>();
  for (const { e, realPath, stat } of appDirStats) {
    if (seenAppRealPaths.has(realPath)) continue;
    seenAppRealPaths.add(realPath);
    if (!stat || !stat.isDirectory()) continue;
    if (seenFilePaths.has(e.rel)) continue;
    seenFilePaths.add(e.rel);
    fileItems.push({
      path: e.rel,
      name: path.basename(e.abs),
      mime: APP_DIR_MIME,
      // Size of a directory entry isn't meaningful — the user-facing
      // renderer should show a count of fragments or skip the size
      // field entirely, not the byte-size of the inode.
      size: 0,
      createdAt: stat.mtime.toISOString(),
      updatedAtMs: String(stat.mtimeMs),
      isDir: true,
    });
  }
  fileItems.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const folderItems: FolderRef[] = [];
  const seenFolderPaths = new Set<string>();
  for (const { e, stat } of folderStats) {
    if (!stat || !stat.isDirectory()) continue;
    if (seenFolderPaths.has(e.rel)) continue;
    seenFolderPaths.add(e.rel);
    folderItems.push({
      path: e.rel,
      name: path.basename(e.abs),
      createdAt: stat.mtime.toISOString(),
    });
  }
  folderItems.sort((a, b) => (a.path < b.path ? -1 : 1));

  return { fileItems, folderItems };
}

/**
 * Creates an empty folder at the workspace-root-relative `subpath`. The
 * subpath is validated against traversal, hidden segments, and
 * backslashes via `validateLibrarySubpath`. Intermediate parents are
 * created automatically. Returns the FolderRef.
 *
 * Throws ValidationError when the subpath is empty or when a file with
 * that name already exists at the target path.
 */
export async function createLibraryFolder(
  ctx: LibraryContext,
  slug: string,
  subpath: string,
): Promise<FolderRef> {
  const sub = validateLibrarySubpath(subpath);
  if (!sub) {
    throw new ValidationError("Folder path must not be empty");
  }
  const root = workspaceRootPath(ctx.home, slug);
  const abs = path.join(root, sub);

  const existing = await fs.stat(abs).catch(() => null);
  if (existing && existing.isFile()) {
    throw new ValidationError(`A file already exists at: ${sub}`);
  }
  await fs.mkdir(abs, { recursive: true });
  invalidateLibraryListCache(slug);

  const stat = await fs.stat(abs);
  return {
    path: path.relative(root, abs).split(path.sep).join("/"),
    name: path.basename(abs),
    createdAt: stat.mtime.toISOString(),
  };
}

/**
 * Moves or renames a library entry (file OR folder) from one
 * workspace-root-relative path to another. Both paths are validated
 * against traversal and hidden-segment rules. Intermediate parents of
 * the destination are created. The destination must not already exist.
 *
 * For files, no symlink is left behind (unlike storage-level moveFile)
 * because library paths are user-facing and the extra breadcrumb would
 * be confusing. Callers should invalidate any cached references.
 */
export async function moveLibraryEntry(
  ctx: LibraryContext,
  slug: string,
  fromRel: string,
  toRel: string,
): Promise<{ kind: "file" | "folder"; path: string; affectedChatIds: string[] }> {
  // Both sides must be safe, non-hidden workspace-root-relative paths.
  validateLibrarySubpath(fromRel);
  const toSub = validateLibrarySubpath(toRel);
  if (!toSub) {
    throw new ValidationError("Destination path must not be empty");
  }

  const fromAbs = resolveHostPath(ctx.home, slug, fromRel);
  const toAbs = resolveHostPath(ctx.home, slug, toRel);

  const fromStat = await fs.stat(fromAbs).catch(() => null);
  if (!fromStat) throw new NotFoundError(`Not found: ${fromRel}`);

  const toStat = await fs.stat(toAbs).catch(() => null);
  if (toStat) {
    throw new ValidationError(`Destination already exists: ${toRel}`);
  }

  // Refuse to move a folder into its own descendant (would create an
  // infinite path and corrupt the subtree).
  if (fromStat.isDirectory()) {
    const fromWithSep = fromAbs.endsWith(path.sep) ? fromAbs : fromAbs + path.sep;
    if (toAbs === fromAbs || toAbs.startsWith(fromWithSep)) {
      throw new ValidationError("Cannot move a folder into itself or a descendant");
    }
  }

  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.rename(fromAbs, toAbs);
  invalidateLibraryListCache(slug);

  // Re-point chat attachment symlinks (`.chats/{chatId}/attachments/`)
  // that targeted the moved entry. Chat pins (see pinLibraryFileToChat
  // in files.ts) use relative targets so they survive the sandbox mount;
  // this walk rewrites the link to the new target after a library rename.
  // Best-effort: any failure is swallowed so the rename itself stays
  // committed. The returned chat-id set lets the caller invalidate
  // those chats' Files-panel caches.
  const affected = await retargetChatAttachmentSymlinks(ctx, slug, fromAbs, toAbs)
    .catch(() => new Set<string>());

  return {
    kind: fromStat.isDirectory() ? "folder" : "file",
    path: toRel,
    affectedChatIds: Array.from(affected),
  };
}

/**
 * Walks every chat's `attachments/` directory and rewrites any symlink
 * whose absolute target was `fromAbs` (file rename) or sat under
 * `fromAbs/` (folder rename) so it points to the matching path under
 * `toAbs` instead. Each per-link update is best-effort and non-fatal —
 * a bad link is left as-is rather than aborting the rename.
 */
async function retargetChatAttachmentSymlinks(
  ctx: LibraryContext,
  slug: string,
  fromAbs: string,
  toAbs: string,
): Promise<Set<string>> {
  const chatsRoot = chatsDir(ctx.home, slug);
  const chatIds = await fs.readdir(chatsRoot).catch(() => [] as string[]);
  const fromWithSep = fromAbs.endsWith(path.sep) ? fromAbs : fromAbs + path.sep;
  const affected = new Set<string>();

  for (const chatId of chatIds) {
    const attDir = path.join(chatsRoot, chatId, "attachments");
    let entries: Dirent[];
    try {
      entries = await fs.readdir(attDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue;
      const linkPath = path.join(attDir, entry.name);
      const target = await fs.readlink(linkPath).catch(() => null);
      if (target === null) continue;
      const resolved = path.isAbsolute(target)
        ? target
        : path.resolve(attDir, target);

      let newTarget: string | null = null;
      if (resolved === fromAbs) {
        newTarget = toAbs;
      } else if (resolved.startsWith(fromWithSep)) {
        newTarget = toAbs + resolved.slice(fromAbs.length);
      }
      if (newTarget === null) continue;

      // Track this chat as affected before attempting the rewrite — even
      // if unlink/symlink fail, the chat's Files panel is showing stale
      // data and should be re-fetched.
      affected.add(chatId);

      // File renames change the basename (foo.txt → bar.txt) and the
      // sidebar reads its display name from the link filename, so the
      // link itself has to follow. Folder renames preserve basenames,
      // so this branch is a no-op for them. uniqueDestPath disambiguates
      // against any other entry already at that name (matches how
      // pinLibraryFileToChat resolves its initial collisions).
      const desiredName = path.basename(newTarget);
      let nextLinkPath = linkPath;
      if (path.basename(linkPath) !== desiredName) {
        nextLinkPath = await uniqueDestPath(attDir, desiredName);
      }

      try {
        await fs.unlink(linkPath);
        await fs.symlink(relativeSymlinkTarget(nextLinkPath, newTarget), nextLinkPath);
      } catch {
        // Leave the original (now-dangling) link in place rather than
        // failing the rename. listAttachments filters dead links out.
      }
    }
  }
  return affected;
}

/**
 * Builds the on-disk shortcut body in the host OS's native format so
 * the file behaves like a real link when the user opens the workspace
 * directly in their file manager:
 *   - macOS: `.webloc` (plist XML)
 *   - Windows: `.url` (INI)
 *   - Linux + other: `.desktop` with `Type=Link`
 *
 * All formats include the URL on a `URL=...` or `<string>...</string>`
 * line; the UI extracts it with a format-agnostic regex when previewing.
 */
function formatLinkForHost(displayName: string, url: string): { ext: string; body: string } {
  const platform = process.platform;
  if (platform === "darwin") {
    const escaped = url
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<plist version="1.0">\n` +
      `<dict>\n` +
      `\t<key>URL</key>\n` +
      `\t<string>${escaped}</string>\n` +
      `</dict>\n` +
      `</plist>\n`;
    return { ext: ".webloc", body };
  }
  if (platform === "win32") {
    return {
      ext: ".url",
      body: `[InternetShortcut]\r\nURL=${url}\r\n`,
    };
  }
  // freedesktop .desktop with Type=Link — the standard for Linux
  // desktops (GNOME, KDE) when launching opens the URL in the default
  // browser. Name is required by the spec; fall back to the URL.
  const safeName = displayName.replace(/[\r\n]/g, " ").trim() || url;
  return {
    ext: ".desktop",
    body: `[Desktop Entry]\nVersion=1.0\nType=Link\nName=${safeName}\nURL=${url}\n`,
  };
}

/**
 * Strips characters that are illegal in filenames on common host
 * filesystems, plus leading dots (which are reserved for hidden /
 * agent-origin entries). Empty results fall back to "link" so we
 * always have a writable basename.
 */
function sanitizeLinkBaseName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[ -<>:"/\\|?*]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 100);
  return cleaned || "link";
}

function validateLinkUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError(`Invalid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError(`URL must be http or https: ${raw}`);
  }
  return parsed.toString();
}

export interface CreateLinkInput {
  workspaceId: string;
  workspaceSlug: string;
  /** User-facing label; becomes the filename stem and (on Linux) the
   * `.desktop` Name= field. */
  name: string;
  /** http or https URL. */
  url: string;
  /** Workspace-root-relative subdirectory; same rules as upload. */
  subpath?: string;
}

/**
 * Writes a URL shortcut to the workspace library in the host OS's
 * native format. Reuses `uploadArtifact` so the entry inherits the
 * usual safeguards (subpath validation, hidden-name rejection, atomic
 * temp+rename, collision-safe filename).
 */
export async function createLibraryLink(
  ctx: StorageContext,
  input: CreateLinkInput,
): Promise<FileRef> {
  const url = validateLinkUrl(input.url);
  const stem = sanitizeLinkBaseName(input.name);
  const { ext, body } = formatLinkForHost(stem, url);
  return uploadArtifact(ctx, {
    workspaceId: input.workspaceId,
    workspaceSlug: input.workspaceSlug,
    name: `${stem}${ext}`,
    mime: "text/uri-list",
    stream: Readable.from(Buffer.from(body, "utf-8")),
    subpath: input.subpath,
  });
}

/**
 * Deletes a library entry (file OR folder) by moving it into
 * `~/Desk/.trash/library/{timestamp}-{basename}`. The trash layout
 * mirrors the live layout loosely so an operator can dig items back out
 * by hand.
 */
export async function deleteLibraryEntry(
  ctx: LibraryContext,
  slug: string,
  relPath: string,
): Promise<{ kind: "file" | "folder" }> {
  const sub = validateLibrarySubpath(relPath);
  if (!sub) {
    throw new ValidationError("Cannot delete the workspace root");
  }

  const abs = resolveHostPath(ctx.home, slug, relPath);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new NotFoundError(`Not found: ${relPath}`);

  const trash = path.join(trashDir(ctx.home), "library");
  await fs.mkdir(trash, { recursive: true });
  const stamp = Date.now();
  const trashName = `${stamp}-${path.basename(abs)}`;
  await fs.rename(abs, path.join(trash, trashName));
  invalidateLibraryListCache(slug);

  return { kind: stat.isDirectory() ? "folder" : "file" };
}
