import * as fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type Pool } from "@agent-desk/db";
import {
  NotFoundError,
  MAX_UPLOAD_BYTES,
  ValidationError,
} from "@agent-desk/shared";
import {
  chatArtifactsDir,
  chatAttachmentsDir,
  resolveHostPath,
  resolveLibraryHostPath,
  tmpDir,
  trashDir,
  workspaceRootPath,
  type VirtualLibraryMount,
} from "./layout.js";
import { invalidateLibraryListCache } from "./library-cache.js";
import { ID_PREFIXES } from "@agent-desk/shared";

/**
 * Per-request storage context — carries the DB pool + Desk home root.
 * Workspace-scoped helpers take a `slug` alongside this context so
 * every workspace's files live under their own directory.
 */
export interface StorageContext {
  pool: Pool;
  home: string;
}

export interface UploadArtifactInput {
  /** Workspace whose on-disk slug this upload is destined for. */
  workspaceId: string;
  /** The workspace's `path` column — the directory name under `~/Desk/`. */
  workspaceSlug: string;
  chatId?: string;
  name: string;
  mime: string;
  stream: Readable;
  /**
   * Optional workspace-root-relative subdirectory (e.g. "Projects/Q2").
   * Only applies to library uploads (no chatId). Created recursively if
   * missing. Rejected if it contains `..` segments, absolute paths, or
   * dotfile segments.
   */
  subpath?: string;
}

export interface FileRef {
  /** Workspace-relative path, uses forward slashes. */
  path: string;
  /** The final on-disk filename (may differ from `input.name` if a collision was avoided). */
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  /** Last-modified time as a Unix millisecond timestamp string — used as an ETag. */
  updatedAtMs: string;
  /** Whether this file is pinned in the workspace's Pinned view. */
  pinned?: boolean;
  /** True when the entry is a directory rather than a regular file. Set
   * for entries like `<name>.app/` that the walker collapses into a
   * single library/chat-artifact item. */
  isDir?: boolean;
}

/** Extension-to-mime guesser used when the caller didn't provide one. */
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
    case ".gif": return "image/gif";
    default: return "application/octet-stream";
  }
}

/**
 * Validates and normalizes a workspace-root-relative subdirectory.
 * Returns the cleaned subpath with forward slashes, or "" for the root.
 *
 * Rejects: absolute paths, `..` traversal, empty segments,
 * backslashes, and null bytes.
 *
 * Dot-prefixed (hidden) segments are allowed — hidden files behave like
 * regular files for all operations; the only difference is that listing /
 * search APIs hide them unless `showHidden` is set.
 */
export function validateLibrarySubpath(raw: string | undefined): string {
  if (!raw) return "";
  if (raw.includes("\\") || raw.includes("\0")) {
    throw new ValidationError(`Invalid subpath: ${raw}`);
  }
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") return "";
  const segments = trimmed.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new ValidationError(`Invalid subpath segment: ${seg}`);
    }
  }
  return segments.join("/");
}

/**
 * Alias for {@link validateLibrarySubpath}. Previously used a more
 * relaxed rule for read-only paths; now both are identical because hidden
 * (dot-prefixed) paths are treated the same as regular paths everywhere.
 */
export const validateReadableSubpath = validateLibrarySubpath;

/**
 * Rejects filenames reserved for hidden (agent-origin) content. The dotfile
 * convention governs user-visibility workspace-wide; user uploads must
 * always be visible.
 */
function rejectHiddenName(name: string): void {
  if (name.startsWith(".")) {
    throw new ValidationError(
      `Filenames starting with '.' are reserved for agent artifacts. Please rename '${name}' to remove the leading dot.`,
    );
  }
}

/** Generates a non-colliding filename inside `dir` for a desired `name`. */
export async function uniqueDestPath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (true) {
    try {
      await fs.lstat(path.join(dir, candidate));
      candidate = `${stem}-${i}${ext}`;
      i += 1;
    } catch {
      return path.join(dir, candidate);
    }
  }
}

/**
 * Symlinks inside the workspace must survive the sandbox mount, where the
 * same tree appears under /home/agent instead of the host's absolute path.
 */
export function relativeSymlinkTarget(linkPath: string, targetAbs: string): string {
  return path.relative(path.dirname(linkPath), targetAbs).split(path.sep).join("/") || ".";
}

/**
 * Uploads a file to the filesystem. No DB row is written — the FS is the
 * single source of truth. Returns a FileRef describing the workspace-relative
 * path and stat metadata.
 *
 * User uploads must not be dotfile-named. Agent-origin files write through
 * the sandbox filesystem, not this route.
 */
export async function uploadArtifact(
  ctx: StorageContext,
  input: UploadArtifactInput,
): Promise<FileRef> {
  rejectHiddenName(input.name);

  const tmpPath = path.join(tmpDir(ctx.home), crypto.randomUUID());

  let destDir: string;
  if (input.chatId) {
    destDir = await chatAttachmentsDir(ctx.home, input.workspaceSlug, input.chatId);
  } else {
    const root = workspaceRootPath(ctx.home, input.workspaceSlug);
    const sub = validateLibrarySubpath(input.subpath);
    destDir = sub ? path.join(root, sub) : root;
  }
  await fs.mkdir(destDir, { recursive: true });

  const destPath = await uniqueDestPath(destDir, input.name);

  // Stream to temp file, enforcing size limit
  let size = 0;
  const sizeEnforcer = new (await import("node:stream")).Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        callback(new ValidationError(`File exceeds maximum size of ${MAX_UPLOAD_BYTES} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(input.stream, sizeEnforcer, createWriteStream(tmpPath));
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }

  try {
    await fs.rename(tmpPath, destPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }

  const stat = await fs.stat(destPath);
  const relPath = path.relative(workspaceRootPath(ctx.home, input.workspaceSlug), destPath);

  // Chat-scoped uploads land under `.chats/{chatId}/attachments/` and don't
  // affect the library listing, so skip the invalidation in that case.
  if (!input.chatId) {
    invalidateLibraryListCache(input.workspaceSlug);
  }

  return {
    path: relPath.split(path.sep).join("/"),
    name: path.basename(destPath),
    mime: input.mime || guessMime(input.name),
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
    updatedAtMs: String(stat.mtimeMs),
  };
}

async function fileRefFromDisk(
  home: string,
  slug: string,
  relPath: string,
  virtualMounts?: readonly VirtualLibraryMount[],
): Promise<FileRef> {
  const abs = resolveLibraryHostPath(home, slug, relPath, virtualMounts);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new NotFoundError(`File not found: ${relPath}`);
  // Allow `.app/` directories to be stat'd so the frontend can render them
  // as app iframes. Other directories are still rejected.
  if (stat.isDirectory()) {
    const name = path.basename(abs);
    if (!name.endsWith(".app") || name === ".app") {
      throw new NotFoundError(`Not a file: ${relPath}`);
    }
    return {
      path: relPath.split(path.sep).join("/"),
      name,
      mime: "inode/directory",
      size: 0,
      createdAt: stat.birthtime.toISOString(),
      updatedAtMs: String(stat.mtimeMs),
      isDir: true,
    };
  }
  if (!stat.isFile()) throw new NotFoundError(`Not a file: ${relPath}`);
  return {
    path: relPath.split(path.sep).join("/"),
    name: path.basename(abs),
    mime: guessMime(abs),
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
    updatedAtMs: String(stat.mtimeMs),
  };
}

/**
 * Opens a file for reading. The `ref` is the workspace-relative path
 * returned by uploadArtifact / listLibrary. `virtualMounts` lets paths
 * projected from connected host directories (e.g. `Downloads/foo.md`)
 * resolve to the actual host file instead of 404'ing inside the
 * workspace tree.
 */
export async function readFile(
  ctx: StorageContext,
  slug: string,
  relPath: string,
  virtualMounts?: readonly VirtualLibraryMount[],
): Promise<{ stream: Readable; file: FileRef }> {
  const file = await fileRefFromDisk(ctx.home, slug, relPath, virtualMounts);
  const abs = resolveLibraryHostPath(ctx.home, slug, relPath, virtualMounts);
  const stream = createReadStream(abs);
  return { stream, file };
}

/** Alias — callers that want the download semantics. */
export async function downloadFile(
  ctx: StorageContext,
  slug: string,
  relPath: string,
  virtualMounts?: readonly VirtualLibraryMount[],
): Promise<{ stream: Readable; file: FileRef }> {
  return readFile(ctx, slug, relPath, virtualMounts);
}

/**
 * Stat a file without opening a read stream. Throws NotFoundError if missing.
 */
export async function statFile(
  ctx: StorageContext,
  slug: string,
  relPath: string,
  virtualMounts?: readonly VirtualLibraryMount[],
): Promise<FileRef> {
  return fileRefFromDisk(ctx.home, slug, relPath, virtualMounts);
}

/**
 * Existence-only stat that accepts any path (files OR directories) inside
 * the workspace. Used by the pin route to validate a target without the
 * `fileRefFromDisk` directory restriction (which rejects non-`.app` dirs).
 */
export async function statPath(
  ctx: StorageContext,
  slug: string,
  relPath: string,
  virtualMounts?: readonly VirtualLibraryMount[],
): Promise<{ isDir: boolean }> {
  const abs = resolveLibraryHostPath(ctx.home, slug, relPath, virtualMounts);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new NotFoundError(`Path not found: ${relPath}`);
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new NotFoundError(`Path not found: ${relPath}`);
  }
  return { isDir: stat.isDirectory() };
}

/**
 * Saves content to a library file. Creates the file (and any missing
 * parent directories) when it doesn't exist yet, or overwrites the
 * existing file in place. This makes hidden files created by the agent
 * (`.memory/workspace.md`, etc.) saveable through the same PUT endpoint
 * as user-uploaded files — no separate creation step required.
 *
 * Writes through a temp file + atomic rename so partial writes don't
 * leave the target truncated.
 */
export async function overwriteFile(
  ctx: StorageContext,
  slug: string,
  relPath: string,
  stream: Readable,
  virtualMounts?: readonly VirtualLibraryMount[],
): Promise<FileRef> {
  const abs = resolveLibraryHostPath(ctx.home, slug, relPath, virtualMounts);
  const stat = await fs.stat(abs).catch(() => null);
  if (stat && !stat.isFile()) throw new NotFoundError(`Not a file: ${relPath}`);

  // Ensure parent directory exists so new files in nested hidden paths
  // (e.g. .memory/workspace.md) can be created via PUT.
  const parent = path.dirname(abs);
  await fs.mkdir(parent, { recursive: true });

  // Place the temp file beside the target rather than under Desk's tmp
  // dir. Virtual mounts can live on a different filesystem (e.g. a user's
  // home directory on a separate mount), and `fs.rename` across devices
  // fails with EXDEV.
  const tmpPath = path.join(parent, `.tmp-${crypto.randomUUID()}`);
  let size = 0;
  const sizeEnforcer = new (await import("node:stream")).Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        callback(new ValidationError(`File exceeds maximum size of ${MAX_UPLOAD_BYTES} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(stream, sizeEnforcer, createWriteStream(tmpPath));
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  try {
    await fs.rename(tmpPath, abs);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  invalidateLibraryListCache(slug);
  return fileRefFromDisk(ctx.home, slug, relPath, virtualMounts);
}

/**
 * Pins an existing library file to a chat by symlinking it into the
 * chat's `.chats/{chatId}/attachments/` directory. The library file is
 * not copied or moved — the symlink exists purely so `listAttachments`
 * surfaces the pinned file in the chat's "In this chat" sidebar list.
 *
 * Idempotent: if a symlink with the same basename already points at the
 * same target, returns its FileRef unchanged. On basename collision with
 * a different target, falls back to the same `name-1.ext` rename scheme
 * `uploadArtifact` uses.
 *
 * Returns a FileRef whose `path` is the symlink's workspace-relative
 * path (under `.chats/{chatId}/attachments/`). `fs.stat` follows the
 * link, so size / createdAt reflect the underlying library file.
 */
export async function pinLibraryFileToChat(
  ctx: StorageContext,
  slug: string,
  chatId: string,
  libraryRelPath: string,
): Promise<FileRef> {
  const targetAbs = resolveHostPath(ctx.home, slug, libraryRelPath);
  const targetStat = await fs.stat(targetAbs).catch(() => null);
  if (!targetStat) throw new NotFoundError(`File not found: ${libraryRelPath}`);
  const isAppDir =
    targetStat.isDirectory() &&
    path.basename(targetAbs).endsWith(".app") &&
    path.basename(targetAbs) !== ".app";
  if (!targetStat.isFile() && !isAppDir) throw new ValidationError(`Not a file: ${libraryRelPath}`);

  const root = workspaceRootPath(ctx.home, slug);
  const attDir = await chatAttachmentsDir(ctx.home, slug, chatId);

  // A library path that already lives inside this chat's attachments dir
  // is already pinned (or is a chat-local upload). Pinning it would
  // create a self-referential symlink — refuse.
  if (targetAbs === attDir || targetAbs.startsWith(attDir + path.sep)) {
    throw new ValidationError(`Cannot pin a file that is already a chat attachment: ${libraryRelPath}`);
  }

  const desiredName = path.basename(targetAbs);

  // The same library target can be reachable through more than one visible
  // path (for example after an app was saved/promoted under an alias). Treat
  // the chat pin as a reference to the resolved target, not just to the
  // requested basename, so pinning an alias does not create a second sidebar
  // entry for the same app/file.
  const existingNames = await fs.readdir(attDir).catch(() => [] as string[]);
  for (const name of existingNames) {
    const existingAbs = path.join(attDir, name);
    const existingLink = await fs.readlink(existingAbs).catch(() => null);
    if (existingLink === null) continue;
    const resolvedExisting = path.isAbsolute(existingLink)
      ? existingLink
      : path.resolve(attDir, existingLink);
    if (resolvedExisting !== targetAbs) continue;
    const portableTarget = relativeSymlinkTarget(existingAbs, targetAbs);
    if (existingLink !== portableTarget) {
      await fs.unlink(existingAbs);
      await fs.symlink(portableTarget, existingAbs);
    }
    const stat = await fs.stat(existingAbs).catch(() => null);
    if (!stat) continue;
    const relPath = path.relative(root, existingAbs).split(path.sep).join("/");
    if (isAppDir) {
      return {
        path: relPath,
        name,
        mime: "application/vnd.desk.app+directory",
        size: 0,
        createdAt: stat.birthtime.toISOString(),
        updatedAtMs: String(stat.mtimeMs),
        isDir: true,
      };
    }
    return {
      path: relPath,
      name,
      mime: guessMime(name),
      size: stat.size,
      createdAt: stat.birthtime.toISOString(),
      updatedAtMs: String(stat.mtimeMs),
    };
  }

  const sameNameAbs = path.join(attDir, desiredName);
  const existingTarget = await fs.readlink(sameNameAbs).catch(() => null);
  if (existingTarget !== null) {
    // Existing symlink at the desired name. If it points at the same
    // library file, this pin is a no-op — return its FileRef.
    const resolvedExisting = path.isAbsolute(existingTarget)
      ? existingTarget
      : path.resolve(attDir, existingTarget);
    if (resolvedExisting === targetAbs) {
      const portableTarget = relativeSymlinkTarget(sameNameAbs, targetAbs);
      if (existingTarget !== portableTarget) {
        await fs.unlink(sameNameAbs);
        await fs.symlink(portableTarget, sameNameAbs);
      }
      const stat = await fs.stat(sameNameAbs).catch(() => null);
      if (stat) {
        const relPath = path.relative(root, sameNameAbs).split(path.sep).join("/");
        if (isAppDir) {
          return {
            path: relPath,
            name: desiredName,
            mime: "application/vnd.desk.app+directory",
            size: 0,
            createdAt: stat.birthtime.toISOString(),
            updatedAtMs: String(stat.mtimeMs),
            isDir: true,
          };
        }
        return {
          path: relPath,
          name: desiredName,
          mime: guessMime(desiredName),
          size: stat.size,
          createdAt: stat.birthtime.toISOString(),
          updatedAtMs: String(stat.mtimeMs),
        };
      }
    }
  }

  const linkPath = await uniqueDestPath(attDir, desiredName);
  await fs.symlink(relativeSymlinkTarget(linkPath, targetAbs), linkPath);

  const stat = await fs.stat(linkPath);
  const relPath = path.relative(root, linkPath).split(path.sep).join("/");
  if (isAppDir) {
    return {
      path: relPath,
      name: path.basename(linkPath),
      mime: "application/vnd.desk.app+directory",
      size: 0,
      createdAt: stat.birthtime.toISOString(),
      updatedAtMs: String(stat.mtimeMs),
      isDir: true,
    };
  }
  return {
    path: relPath,
    name: path.basename(linkPath),
    mime: guessMime(linkPath),
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
    updatedAtMs: String(stat.mtimeMs),
  };
}

/**
 * Promotes a chat attachment from `.chats/{chatId}/attachments/` into the
 * primary workspace library (optionally inside `destSubpath`). The original
 * location is replaced with a symlink to the new path so the chat's
 * `listAttachments()` continues to surface the file.
 *
 * `attachmentName` must be a basename — the source is always
 * `.chats/{chatId}/attachments/{attachmentName}`. Rejects when the source is
 * already a symlink (i.e. a previously-pinned library file): a chat-pinned
 * library reference is already in the library, so re-saving is meaningless.
 *
 * Name collisions in the destination directory are resolved by suffixing
 * `-1`, `-2`, …, mirroring `uploadArtifact`'s scheme.
 */
export async function saveChatAttachmentToLibrary(
  ctx: StorageContext,
  slug: string,
  chatId: string,
  attachmentName: string,
  destSubpath?: string,
): Promise<FileRef> {
  if (path.basename(attachmentName) !== attachmentName) {
    throw new ValidationError(`Invalid attachment name: ${attachmentName}`);
  }
  rejectHiddenName(attachmentName);

  const sub = validateLibrarySubpath(destSubpath);
  const root = workspaceRootPath(ctx.home, slug);
  const attDir = await chatAttachmentsDir(ctx.home, slug, chatId);
  const srcAbs = path.join(attDir, attachmentName);

  const srcStat = await fs.lstat(srcAbs).catch(() => null);
  if (!srcStat) throw new NotFoundError(`Attachment not found: ${attachmentName}`);
  if (srcStat.isSymbolicLink()) {
    throw new ValidationError(
      `Attachment is already a library reference: ${attachmentName}`,
    );
  }
  if (!srcStat.isFile()) throw new ValidationError(`Not a file: ${attachmentName}`);

  const destDir = sub ? path.join(root, sub) : root;
  await fs.mkdir(destDir, { recursive: true });
  const destAbs = await uniqueDestPath(destDir, attachmentName);

  await fs.rename(srcAbs, destAbs);
  // Best-effort: leave a symlink at the old path so the chat still shows
  // the file via `listAttachments`. If the symlink can't be created the
  // save still succeeded — the chat sidebar will just lose the row.
  await fs.symlink(relativeSymlinkTarget(srcAbs, destAbs), srcAbs).catch(() => {});
  invalidateLibraryListCache(slug);

  const relPath = path.relative(root, destAbs).split(path.sep).join("/");
  return fileRefFromDisk(ctx.home, slug, relPath);
}

/**
 * Promotes a `<name>.app/` chat artifact (a directory under
 * `.chats/{chatId}/artifacts/`) into the primary workspace library.
 * Mirrors `saveChatAttachmentToLibrary` but operates on directories
 * (which the attachment helper rejects).
 *
 * The source directory is renamed in place; the chat artifact is then
 * gone from `.chats/{chatId}/artifacts/`. Unlike attachments, no
 * symlink is left behind — promoted apps are intended to live in the
 * library; the modify-as-version flow copies a library app back into a
 * chat for editing.
 *
 * `artifactName` must be a basename ending in `.app`. The destination
 * defaults to the workspace root; pass `destSubpath` to land under a
 * library subfolder. If an app with the same path already exists, replace
 * it instead of creating a suffixed duplicate. The previous copy goes to
 * the same app-version trash used by the explicit replace flow.
 */
export async function saveChatArtifactToLibrary(
  ctx: StorageContext,
  slug: string,
  chatId: string,
  artifactName: string,
  destSubpath?: string,
): Promise<FileRef> {
  if (path.basename(artifactName) !== artifactName) {
    throw new ValidationError(`Invalid artifact name: ${artifactName}`);
  }
  rejectHiddenName(artifactName);
  if (!artifactName.endsWith(".app") || artifactName === ".app") {
    throw new ValidationError(
      `saveChatArtifactToLibrary only supports <name>.app/ directories: ${artifactName}`,
    );
  }

  const sub = validateLibrarySubpath(destSubpath);
  const artDir = chatArtifactsDir(ctx.home, slug, chatId);
  const srcAbs = path.join(artDir, artifactName);

  const srcStat = await fs.lstat(srcAbs).catch(() => null);
  if (!srcStat) throw new NotFoundError(`Artifact not found: ${artifactName}`);
  if (srcStat.isSymbolicLink()) {
    throw new ValidationError(
      `Artifact is a symlink, refusing to promote: ${artifactName}`,
    );
  }
  if (!srcStat.isDirectory()) {
    throw new ValidationError(`Not a directory: ${artifactName}`);
  }

  const targetPath = sub ? `${sub}/${artifactName}` : artifactName;
  return replaceLibraryAppFromChat(ctx, slug, chatId, artifactName, targetPath);
}

/**
 * The "version" of a library app — the mtime of its `desk.app.json`
 * manifest, as a string of milliseconds. Captured at copy time so the
 * UI can pass it back at replace time, and the server can detect whether
 * the library copy moved while the user was editing in the chat.
 *
 * Returns null when the manifest doesn't exist (e.g. the library app is
 * malformed); in that case, the replace endpoint won't enforce the
 * If-Match check.
 */
async function libraryAppVersion(appAbs: string): Promise<string | null> {
  try {
    const s = await fs.stat(path.join(appAbs, "desk.app.json"));
    return String(s.mtimeMs);
  } catch {
    return null;
  }
}

export interface CopyLibraryAppResult extends FileRef {
  /**
   * Snapshot of the LIBRARY source's manifest mtime at copy time. The UI
   * stores this and passes it back to `replaceLibraryAppFromChat` as
   * `expectedSourceVersion` so the server can detect concurrent edits.
   */
  sourceVersion: string | null;
}

function validateLibraryAppPath(raw: string, field: string): string {
  if (raw.includes("\\") || raw.includes("\0")) {
    throw new ValidationError(`Invalid ${field}: ${raw}`);
  }

  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed || !trimmed.endsWith(".app") || trimmed === ".app") {
    throw new ValidationError(`${field} must be a <name>.app path`);
  }

  // Block paths that reach into internal directories — .chats/ is chat
  // infrastructure, not user library content.
  if (trimmed.startsWith(".chats/")) {
    throw new ValidationError(`${field} must not be inside .chats/: ${trimmed}`);
  }

  // Dot-prefixed (hidden) segments are allowed — an app inside a hidden
  // folder (e.g. `.drafts/my.app`) should be copyable just like any other.
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ValidationError(`Invalid ${field} segment: ${segment}`);
    }
  }

  return segments.join("/");
}

function validateChatAppArtifactName(raw: string): string {
  if (raw.includes("\\")) {
    throw new ValidationError(`Invalid artifact name: ${raw}`);
  }
  if (path.basename(raw) !== raw) {
    throw new ValidationError(`Invalid artifact name: ${raw}`);
  }
  if (!raw.endsWith(".app") || raw === ".app" || raw.startsWith(".")) {
    throw new ValidationError(`Invalid app artifact name: ${raw}`);
  }
  return raw;
}

/**
 * Copies a library `<name>.app/` directory into a chat's artifacts dir
 * so the agent can iterate on it without touching the library copy.
 */
export async function copyLibraryAppToChat(
  ctx: StorageContext,
  slug: string,
  chatId: string,
  libraryRelPath: string,
): Promise<CopyLibraryAppResult> {
  const root = workspaceRootPath(ctx.home, slug);
  const libraryPath = validateLibraryAppPath(libraryRelPath, "library app path");
  const srcAbs = resolveHostPath(ctx.home, slug, libraryPath);
  const linkStat = await fs.lstat(srcAbs).catch(() => null);
  if (linkStat?.isSymbolicLink()) {
    throw new ValidationError(`Library app must not be a symlink: ${libraryPath}`);
  }
  const stat = await fs.stat(srcAbs).catch(() => null);
  if (!stat) throw new NotFoundError(`Library app not found: ${libraryRelPath}`);
  if (!stat.isDirectory()) {
    throw new ValidationError(`Not a directory: ${libraryRelPath}`);
  }
  const baseName = path.basename(srcAbs);
  if (!baseName.endsWith(".app") || baseName === ".app") {
    throw new ValidationError(`Not an app directory: ${libraryRelPath}`);
  }

  const artDir = chatArtifactsDir(ctx.home, slug, chatId);
  await fs.mkdir(artDir, { recursive: true });
  const destAbs = path.join(artDir, baseName);
  const existing = await fs.lstat(destAbs).catch(() => null);
  if (existing) {
    throw new ValidationError(
      `Chat artifact already exists: ${baseName}. Remove it first or pick another name.`,
    );
  }

  const sourceVersion = await libraryAppVersion(srcAbs);

  await fs.cp(srcAbs, destAbs, {
    recursive: true,
    dereference: false,
    force: false,
  });

  const destStat = await fs.stat(destAbs);
  const relPath = path.relative(root, destAbs).split(path.sep).join("/");
  return {
    path: relPath,
    name: baseName,
    mime: "application/vnd.desk.app+directory",
    size: 0,
    createdAt: destStat.birthtime.toISOString(),
    updatedAtMs: String(destStat.mtimeMs),
    isDir: true,
    sourceVersion,
  };
}

export interface ReplaceLibraryAppOptions {
  /**
   * Optional `If-Match`-style version pin. The UI captures
   * `sourceVersion` from `copyLibraryAppToChat` and passes it back here.
   */
  expectedSourceVersion?: string;
}

export class ReplaceLibraryAppConflictError extends ValidationError {
  constructor(
    public readonly expected: string,
    public readonly actual: string | null,
  ) {
    super(
      `Library app moved since copy: expected version ${expected} but found ${actual ?? "<missing manifest>"}.`,
    );
  }
}

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Best-effort lazy sweep of `.trash/.app-versions/` entries older than
 * 30 days. Runs on each replace call so the trash bucket doesn't grow
 * unbounded. Failures are swallowed.
 */
async function pruneAppVersionTrash(home: string): Promise<void> {
  const versionsRoot = path.join(trashDir(home), ".app-versions");
  let entries: string[];
  try {
    entries = await fs.readdir(versionsRoot);
  } catch {
    return;
  }
  const cutoff = Date.now() - TRASH_RETENTION_MS;
  await Promise.all(
    entries.map(async (name) => {
      const entry = path.join(versionsRoot, name);
      try {
        const s = await fs.stat(entry);
        if (s.mtimeMs < cutoff) {
          await fs.rm(entry, { recursive: true, force: true });
        }
      } catch {
        // best-effort
      }
    }),
  );
}

/**
 * Promotes a chat-artifact `<name>.app/` back into the library, replacing
 * the prior library version of the same name. Prior copy goes to trash for
 * recovery; lazy retention sweep clears entries older than 30 days.
 */
export async function replaceLibraryAppFromChat(
  ctx: StorageContext,
  slug: string,
  chatId: string,
  artifactName: string,
  targetRelPath: string,
  opts: ReplaceLibraryAppOptions = {},
): Promise<FileRef> {
  const appName = validateChatAppArtifactName(artifactName);
  const targetPath = validateLibraryAppPath(targetRelPath, "target path");
  const root = workspaceRootPath(ctx.home, slug);
  const srcAbs = path.join(
    chatArtifactsDir(ctx.home, slug, chatId),
    appName,
  );
  const srcStat = await fs.lstat(srcAbs).catch(() => null);
  if (!srcStat) {
    throw new NotFoundError(`Chat artifact not found: ${appName}`);
  }
  if (srcStat.isSymbolicLink()) {
    throw new ValidationError(`Chat artifact must not be a symlink: ${appName}`);
  }
  if (!srcStat.isDirectory()) {
    throw new ValidationError(`Not a directory: ${appName}`);
  }

  const destAbs = resolveHostPath(ctx.home, slug, targetPath);
  const destStat = await fs.lstat(destAbs).catch(() => null);

  if (destStat) {
    if (!destStat.isDirectory()) {
      throw new ValidationError(`Library target is not a directory: ${targetPath}`);
    }

    if (opts.expectedSourceVersion !== undefined) {
      const liveVersion = await libraryAppVersion(destAbs);
      if (liveVersion !== opts.expectedSourceVersion) {
        throw new ReplaceLibraryAppConflictError(
          opts.expectedSourceVersion,
          liveVersion,
        );
      }
    }

    const versionsRoot = path.join(trashDir(ctx.home), ".app-versions");
    await fs.mkdir(versionsRoot, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-");
    const backupAbs = path.join(versionsRoot, `${path.basename(targetPath)}-${stamp}`);
    await fs.rename(destAbs, backupAbs);
  } else {
    await fs.mkdir(path.dirname(destAbs), { recursive: true });
  }

  await fs.rename(srcAbs, destAbs);
  await pruneAppVersionTrash(ctx.home);
  invalidateLibraryListCache(slug);

  const newStat = await fs.stat(destAbs);
  const relPath = path.relative(root, destAbs).split(path.sep).join("/");
  return {
    path: relPath,
    name: path.basename(destAbs),
    mime: "application/vnd.desk.app+directory",
    size: 0,
    createdAt: newStat.birthtime.toISOString(),
    updatedAtMs: String(newStat.mtimeMs),
    isDir: true,
  };
}

/**
 * Permanently removes a chat-artifact `<name>.app/` directory (and its
 * `.storage/data.sqlite` SQLite file by virtue of being a child).
 * Issue #47, PR-E.
 */
export async function deleteChatApp(
  ctx: StorageContext,
  slug: string,
  chatId: string,
  appName: string,
): Promise<void> {
  if (path.basename(appName) !== appName) {
    throw new ValidationError(`Invalid app directory name: ${appName}`);
  }
  if (!appName.endsWith(".app") || appName === ".app") {
    throw new ValidationError(`Not an app directory: ${appName}`);
  }
  const target = path.join(
    chatArtifactsDir(ctx.home, slug, chatId),
    appName,
  );
  const s = await fs.stat(target).catch(() => null);
  if (!s) throw new NotFoundError(`Chat artifact not found: ${appName}`);
  if (!s.isDirectory()) {
    throw new ValidationError(`Not a directory: ${appName}`);
  }
  await fs.rm(target, { recursive: true, force: true });
}

/**
 * Removes a library `<name>.app/` directory by moving it to
 * `~/Desk/.trash/.app-versions/<name>-<timestamp>/`. Recoverable via
 * the same trash bucket modify-as-version uses; its lazy sweep clears
 * entries older than 30 days. Issue #47, PR-E.
 */
export async function deleteLibraryApp(
  ctx: StorageContext,
  slug: string,
  libraryRelPath: string,
): Promise<void> {
  const baseName = path.basename(libraryRelPath);
  if (baseName !== libraryRelPath) {
    throw new ValidationError(`Invalid app directory name: ${libraryRelPath}`);
  }
  if (!baseName.endsWith(".app") || baseName === ".app") {
    throw new ValidationError(`Not an app directory: ${libraryRelPath}`);
  }
  const target = resolveHostPath(ctx.home, slug, libraryRelPath);
  const s = await fs.stat(target).catch(() => null);
  if (!s) throw new NotFoundError(`Library app not found: ${libraryRelPath}`);
  if (!s.isDirectory()) {
    throw new ValidationError(`Not a directory: ${libraryRelPath}`);
  }
  const versionsRoot = path.join(trashDir(ctx.home), ".app-versions");
  await fs.mkdir(versionsRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trashTarget = path.join(versionsRoot, `${baseName}-${stamp}`);
  await fs.rename(target, trashTarget);
  invalidateLibraryListCache(slug);
}

/**
 * Move a file from one workspace-relative path to another. Leaves a symlink
 * at the old path pointing to the new absolute path so existing references
 * remain valid.
 */
export async function moveFile(
  ctx: StorageContext,
  slug: string,
  fromRel: string,
  toRel: string,
): Promise<FileRef> {
  const fromAbs = resolveHostPath(ctx.home, slug, fromRel);
  const toAbs = resolveHostPath(ctx.home, slug, toRel);
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.rename(fromAbs, toAbs);
  // Leave a symlink at the old path pointing to the new location.
  await fs.symlink(relativeSymlinkTarget(fromAbs, toAbs), fromAbs).catch(() => {
    // If the symlink can't be created (e.g. parent dir gone), swallow — the
    // move still succeeded; references to the old path will fail-fast.
  });
  invalidateLibraryListCache(slug);
  return fileRefFromDisk(ctx.home, slug, toRel);
}

/**
 * "Delete" a file by moving it to ~/Desk/.trash/{timestamp}-{name}.
 * The file stays on disk until the trash is purged. After delete, the
 * original path no longer resolves — subsequent reads/stats return 404.
 * The trash itself is not mounted into sandboxes, so the agent cannot
 * see deleted files.
 */
export async function deleteFile(
  ctx: StorageContext,
  slug: string,
  relPath: string,
): Promise<void> {
  const abs = resolveHostPath(ctx.home, slug, relPath);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new NotFoundError(`File not found: ${relPath}`);
  if (!stat.isFile()) throw new NotFoundError(`Not a file: ${relPath}`);

  const trash = trashDir(ctx.home);
  await fs.mkdir(trash, { recursive: true });
  const stamp = Date.now();
  const trashPath = path.join(trash, `${stamp}-${path.basename(abs)}`);
  await fs.rename(abs, trashPath);
  invalidateLibraryListCache(slug);
}

/**
 * Removes a single entry from `.chats/{chatId}/attachments/`. Works for
 * symlinks (library pins) and regular files (direct chat uploads): the
 * unlink only touches the entry inside the chat dir, so a pinned
 * library file's source stays put.
 */
export async function removeChatAttachment(
  ctx: StorageContext,
  slug: string,
  chatId: string,
  attachmentName: string,
): Promise<void> {
  if (path.basename(attachmentName) !== attachmentName) {
    throw new ValidationError(`Invalid attachment name: ${attachmentName}`);
  }
  const attDir = await chatAttachmentsDir(ctx.home, slug, chatId);
  const linkPath = path.join(attDir, attachmentName);
  // lstat (not stat) so a dangling symlink — pointing at a deleted
  // library file — still reports the entry's existence and we can
  // unlink it like any other.
  const stat = await fs.lstat(linkPath).catch(() => null);
  if (!stat) throw new NotFoundError(`Attachment not found: ${attachmentName}`);
  await fs.unlink(linkPath);
}

/**
 * Soft-deletes a chat's on-disk footprint by moving `.chats/{chatId}/`
 * (which holds attachments, logs, and notes/) into
 * `~/Desk/.trash/.chats/`. Idempotent — missing dirs are silently skipped.
 */
export async function trashChatDirectories(
  home: string,
  slug: string,
  chatId: string,
): Promise<{ moved: boolean }> {
  if (!chatId.startsWith(ID_PREFIXES.chat) || chatId.includes("/") || chatId.includes("..")) {
    throw new ValidationError(`Invalid chat id: ${chatId}`);
  }
  const root = workspaceRootPath(home, slug);
  const stamp = Date.now();

  const src = path.join(root, ".chats", chatId);
  const dst = path.join(trashDir(home), ".chats", `${chatId}-${stamp}`);

  const stat = await fs.stat(src).catch(() => null);
  if (!stat) return { moved: false };

  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.rename(src, dst);
  return { moved: true };
}

/**
 * Resolves an absolute host path for a workspace-relative path so the
 * runtime can project it into a sandbox mount. Kept for backward-compat
 * with the pre-FS API; simple wrapper over resolveHostPath.
 */
export async function resolveForSandbox(
  ctx: StorageContext,
  slug: string,
  relPath: string,
): Promise<string> {
  await fileRefFromDisk(ctx.home, slug, relPath);
  return resolveHostPath(ctx.home, slug, relPath);
}
