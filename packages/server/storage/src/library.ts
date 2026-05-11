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
} from "./layout.js";
import {
  uploadArtifact,
  relativeSymlinkTarget,
  uniqueDestPath,
  validateLibrarySubpath,
  type FileRef,
  type StorageContext,
} from "./files.js";

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
  opts: { showHidden: boolean },
): Promise<{ files: string[]; folders: string[]; appDirs: string[] }> {
  const files: string[] = [];
  const folders: string[] = [];
  // `<name>.app/` directories are collapsed into a single library
  // entry rather than expanded; the walker tracks them separately so
  // listLibrary can stat + emit them as `isDir: true` items without
  // ever recursing into the dist/ + node_modules/ underneath.
  const appDirs: string[] = [];
  const respectGitignore = !opts.showHidden;

  const rootFrame = respectGitignore ? await loadGitignoreFrame(dir) : null;
  const stack: Array<{ abs: string; frames: IgnoreFrame[] }> = [
    { abs: dir, frames: rootFrame ? [rootFrame] : [] },
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
      let recurse = false;
      if (e.isDirectory()) {
        kind = "dir";
        recurse = true;
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
        if (recurse) {
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
 * Lists the workspace's library files and folders, recursing through
 * subdirectories.
 *
 * Hidden by default and surfaced together when `showHidden` is set:
 *   - dot-prefixed entries (agent infrastructure, OS/editor cruft);
 *   - entries matched by any `.gitignore` in the subtree, with nested
 *     gitignores composed onto their ancestors' rules — so root-level
 *     `node_modules/` hides the whole tree without polluting the listing.
 *
 * `limit` is opt-in: passing it caps the file list and emits a `nextCursor`
 * for clients that want to page; omitting it returns everything. Cursor is
 * the serialized mtime of the last returned file (strict less-than).
 *
 * Under the workspace-as-home model the workspace root is the library —
 * there is no per-workspace subdirectory. The `workspaceId` argument is
 * retained for API compatibility but ignored in v1.
 */
export async function listLibrary(
  ctx: LibraryContext,
  slug: string,
  opts?: { cursor?: string; limit?: number; showHidden?: boolean },
): Promise<{ items: FileRef[]; folders: FolderRef[]; nextCursor?: string }> {
  const root = workspaceRootPath(ctx.home, slug);
  await fs.mkdir(root, { recursive: true });

  const showHidden = opts?.showHidden ?? false;
  const { files, folders, appDirs } = await walk(root, { showHidden });

  const fileItems: FileRef[] = [];
  for (const abs of files) {
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) continue;
    const name = path.basename(abs);
    const isAppDir = stat.isDirectory() && name.endsWith(".app") && name !== ".app";
    if (!stat.isFile() && !isAppDir) continue;
    fileItems.push({
      path: path.relative(root, abs).split(path.sep).join("/"),
      name,
      mime: isAppDir ? "inode/directory" : guessMime(abs),
      size: isAppDir ? 0 : stat.size,
      createdAt: stat.mtime.toISOString(),
      updatedAtMs: String(stat.mtimeMs),
      isDir: isAppDir || undefined,
    });
  }
  for (const abs of appDirs) {
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;
    fileItems.push({
      path: path.relative(root, abs).split(path.sep).join("/"),
      name: path.basename(abs),
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
  for (const abs of appDirs) {
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;
    fileItems.push({
      path: path.relative(root, abs).split(path.sep).join("/"),
      name: path.basename(abs),
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
  for (const abs of folders) {
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;
    folderItems.push({
      path: path.relative(root, abs).split(path.sep).join("/"),
      name: path.basename(abs),
      createdAt: stat.mtime.toISOString(),
    });
  }
  folderItems.sort((a, b) => (a.path < b.path ? -1 : 1));

  const cursor = opts?.cursor;
  const filtered = cursor
    ? fileItems.filter((e) => e.createdAt < cursor)
    : fileItems;
  const limit = opts?.limit;
  const items = limit !== undefined ? filtered.slice(0, limit) : filtered;
  const nextCursor =
    limit !== undefined && items.length === limit
      ? items[items.length - 1].createdAt
      : undefined;

  return { items, folders: folderItems, nextCursor };
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

  return { kind: stat.isDirectory() ? "folder" : "file" };
}
