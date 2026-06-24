import {
  lstat as fsLstat,
  mkdir as fsMkdir,
  realpath as fsRealpath,
} from "node:fs/promises";
import {
  dirname as pathDirname,
  isAbsolute as pathIsAbsolute,
  join as pathJoin,
  relative as pathRelative,
  sep as pathSep,
} from "node:path";
import { type Pool } from "@roomy-ai/db";
import { NotFoundError } from "@roomy-ai/shared";
import {
  chatArtifactsDir,
  resolveHostPath,
  workspaceRootPath,
  type StorageContext,
} from "@roomy-ai/storage";
import {
  parseReadableChatArtifactPath,
  requireReadablePathInWorkspace,
} from "./workspace-scope.js";

function isInsidePath(root: string, target: string): boolean {
  const rel = pathRelative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${pathSep}`) && !pathIsAbsolute(rel));
}

async function workspaceSlug(pool: Pool, workspaceId: string): Promise<string> {
  const { rows } = await pool.query<{ path: string }>(
    "SELECT path FROM workspaces WHERE id = ?",
    [workspaceId],
  );
  const slug = rows[0]?.path;
  if (!slug) throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  return slug;
}

async function requireExistingContainedPath(root: string, target: string, relPath: string): Promise<void> {
  let realRoot: string;
  let realTarget: string;
  try {
    [realRoot, realTarget] = await Promise.all([
      fsRealpath(root),
      fsRealpath(target),
    ]);
  } catch {
    throw new NotFoundError(`File not found: ${relPath}`);
  }
  if (!isInsidePath(realRoot, realTarget)) {
    throw new NotFoundError(`File not found: ${relPath}`);
  }
}

async function requireWritablePathParents(root: string, target: string, relPath: string): Promise<void> {
  await fsMkdir(root, { recursive: true });
  const realRoot = await fsRealpath(root).catch(() => null);
  if (!realRoot) throw new NotFoundError(`File not found: ${relPath}`);

  const parent = pathDirname(target);
  const rootToParent = pathRelative(root, parent);
  if (rootToParent && (rootToParent === ".." || rootToParent.startsWith(`..${pathSep}`) || pathIsAbsolute(rootToParent))) {
    throw new NotFoundError(`File not found: ${relPath}`);
  }

  let current = root;
  const segments = rootToParent ? rootToParent.split(pathSep).filter(Boolean) : [];
  for (const segment of segments) {
    current = pathJoin(current, segment);
    const st = await fsLstat(current).catch(() => null);
    if (!st) break;
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new NotFoundError(`File not found: ${relPath}`);
    }
    const realCurrent = await fsRealpath(current).catch(() => null);
    if (!realCurrent || !isInsidePath(realRoot, realCurrent)) {
      throw new NotFoundError(`File not found: ${relPath}`);
    }
  }

  const targetStat = await fsLstat(target).catch(() => null);
  if (targetStat?.isSymbolicLink()) {
    throw new NotFoundError(`File not found: ${relPath}`);
  }
  if (targetStat) {
    await requireExistingContainedPath(root, target, relPath);
  }
}

/**
 * Augments `requireReadablePathInWorkspace` (which only checks the DB-
 * level workspace ownership) with a real-path check against the
 * filesystem: a chat artifact must resolve inside its chat's artifacts
 * directory, and that directory must live under the workspace root.
 * Protects against a sibling chat's artifact being read through a
 * symlink that escapes its chat's scope.
 *
 * Kept separate from `workspace-scope.ts` because it adds an fs round-
 * trip the pure path validators don't need (and shouldn't pay).
 *
 * Note on TOCTOU: the realpath check happens here and the caller
 * opens the file separately, so a symlink swap between the two could
 * in theory let an attacker re-aim the path.  Acceptable because
 * exploit requires write access to the workspace directory by
 * another process on the same host — at which point isolation has
 * already failed.  If we ever support workspace mounts that other
 * users can write to, revisit by passing an O_NOFOLLOW file
 * descriptor through to the open path.
 */
export async function requireReadablePathForRoute(
  pool: Pool,
  storage: StorageContext,
  userId: string,
  relPath: string,
  workspaceId: string,
): Promise<void> {
  await requireReadablePathInWorkspace(pool, userId, relPath, workspaceId);
  const artifact = parseReadableChatArtifactPath(relPath);
  if (!artifact) return;

  const { rows: chatRows } = await pool.query<{ workspace_id: string }>(
    "SELECT workspace_id FROM chats WHERE id = ?",
    [artifact.chatId],
  );
  if (chatRows[0]?.workspace_id !== workspaceId) {
    throw new NotFoundError(`File not found: ${relPath}`);
  }

  const { rows } = await pool.query<{ path: string }>(
    "SELECT path FROM workspaces WHERE id = ?",
    [workspaceId],
  );
  const workspaceSlug = rows[0]?.path;
  if (!workspaceSlug) throw new NotFoundError(`Workspace not found: ${workspaceId}`);

  const artifactRoot = chatArtifactsDir(storage.home, workspaceSlug, artifact.chatId);
  const workspaceRoot = workspaceRootPath(storage.home, workspaceSlug);
  const target = resolveHostPath(storage.home, workspaceSlug, relPath);
  let realWorkspaceRoot: string;
  let realRoot: string;
  let realTarget: string;
  try {
    [realWorkspaceRoot, realRoot, realTarget] = await Promise.all([
      fsRealpath(workspaceRoot),
      fsRealpath(artifactRoot),
      fsRealpath(target),
    ]);
  } catch {
    throw new NotFoundError(`File not found: ${relPath}`);
  }
  if (realRoot !== realWorkspaceRoot && !realRoot.startsWith(realWorkspaceRoot + pathSep)) {
    throw new NotFoundError(`File not found: ${relPath}`);
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + pathSep)) {
    throw new NotFoundError(`File not found: ${relPath}`);
  }
}

export async function requireExistingLibraryPathForRoute(
  pool: Pool,
  storage: StorageContext,
  relPath: string,
  workspaceId: string,
): Promise<void> {
  const slug = await workspaceSlug(pool, workspaceId);
  const root = workspaceRootPath(storage.home, slug);
  const target = resolveHostPath(storage.home, slug, relPath);
  await requireExistingContainedPath(root, target, relPath);
}

export async function requireLibraryDestinationForRoute(
  pool: Pool,
  storage: StorageContext,
  relPath: string,
  workspaceId: string,
): Promise<void> {
  const slug = await workspaceSlug(pool, workspaceId);
  const root = workspaceRootPath(storage.home, slug);
  const target = resolveHostPath(storage.home, slug, relPath);
  await requireWritablePathParents(root, target, relPath);
}
