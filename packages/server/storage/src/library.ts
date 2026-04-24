import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import pg from "pg";
import { NotFoundError, ValidationError } from "@desk/shared";
import { workspaceRootPath, trashDir, resolveHostPath } from "./layout.js";
import {
  uploadArtifact,
  validateLibrarySubpath,
  type FileRef,
  type StorageContext,
} from "./files.js";

export interface LibraryContext {
  pool: pg.Pool;
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

/**
 * Recursively walks `dir`, collecting files and subdirectories. Both lists
 * are returned as absolute paths for the caller to project into
 * workspace-relative form.
 *
 * Dotfile visibility rule applies uniformly: when `showHidden` is false
 * (default), dot-prefixed entries are skipped at every level — including
 * their subtrees, so `.chats/` contents stay invisible to listings.
 */
async function walk(
  dir: string,
  opts: { showHidden: boolean },
): Promise<{ files: string[]; folders: string[] }> {
  const files: string[] = [];
  const folders: string[] = [];
  const stack: string[] = [dir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Array<{ name: string; isFile: boolean; isDirectory: boolean }>;
    try {
      const raw = await fs.readdir(current, { withFileTypes: true });
      entries = raw.map((e) => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
      }));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!opts.showHidden && e.name.startsWith(".")) continue;
      const abs = path.join(current, e.name);
      if (e.isDirectory) {
        folders.push(abs);
        stack.push(abs);
      } else if (e.isFile) {
        files.push(abs);
      }
    }
  }

  return { files, folders };
}

/**
 * Lists the workspace's library files and folders, recursing through
 * subdirectories. Sort is by mtime DESC for both lists; cursor / limit
 * paginate the file list only (folders are cheap and small enough to
 * return whole).
 *
 * Cursor is the serialized mtime of the last returned file; only files
 * with mtime strictly less than the cursor appear in the next page.
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
  const { files, folders } = await walk(root, { showHidden });

  const fileItems: FileRef[] = [];
  for (const abs of files) {
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    fileItems.push({
      path: path.relative(root, abs).split(path.sep).join("/"),
      name: path.basename(abs),
      mime: guessMime(abs),
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
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
  const limit = opts?.limit ?? 50;
  const items = filtered.slice(0, limit);
  const nextCursor = items.length === limit ? items[items.length - 1].createdAt : undefined;

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
): Promise<{ kind: "file" | "folder"; path: string }> {
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

  return {
    kind: fromStat.isDirectory() ? "folder" : "file",
    path: toRel,
  };
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
