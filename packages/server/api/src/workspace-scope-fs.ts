import { realpath as fsRealpath } from "node:fs/promises";
import { sep as pathSep } from "node:path";
import { type Pool } from "@agent-desk/db";
import { NotFoundError } from "@agent-desk/shared";
import {
  chatArtifactsDir,
  resolveHostPath,
  workspaceRootPath,
  type StorageContext,
} from "@agent-desk/storage";
import {
  parseReadableChatArtifactPath,
  requireReadablePathInWorkspace,
} from "./workspace-scope.js";

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
