import pg from "pg";
import { NotFoundError, ValidationError } from "@desk/shared";
import { queries } from "@desk/db";
import { requireOwnedWorkspace } from "./auth/ownership.js";

const WORKSPACE_ID_PATTERN = /^wks_[A-Za-z0-9_-]+$/;

/**
 * Resolves the workspace scope for flat list/mutation routes that accept
 * `?workspaceId=`. When provided, the id is validated and ownership is
 * enforced via `requireOwnedWorkspace` (404 on mismatch, not 403, per the
 * existing convention). When absent, falls back to the caller's first
 * workspace for backwards-compat with older clients.
 *
 * Returns null only when both (a) no query param was given and (b) the user
 * has zero workspaces — the caller decides whether that's an empty response
 * (list endpoints) or an error (mutating endpoints).
 */
export async function resolveWorkspaceId(
  pool: pg.Pool,
  userId: string,
  query: URLSearchParams,
): Promise<string | null> {
  const q = query.get("workspaceId");
  if (q !== null && q !== "") {
    if (!WORKSPACE_ID_PATTERN.test(q)) {
      throw new ValidationError(`Invalid workspaceId: ${q}`);
    }
    await requireOwnedWorkspace(pool, q, userId);
    return q;
  }
  const workspaces = await queries.workspaces.listByUser(pool, userId);
  return workspaces.length > 0 ? workspaces[0].id : null;
}

/**
 * Like `resolveWorkspaceId` but throws `NotFoundError` when the user has no
 * workspaces — used by mutating routes (POST/DELETE) where an empty list
 * response makes no sense.
 */
export async function requireWorkspaceId(
  pool: pg.Pool,
  userId: string,
  query: URLSearchParams,
): Promise<string> {
  const wsId = await resolveWorkspaceId(pool, userId, query);
  if (!wsId) throw new NotFoundError("No workspace available");
  return wsId;
}

/**
 * Confirms that a workspace-relative library path (`library/{wsId}/...`)
 * belongs to the given workspace. Returns the path unchanged when it
 * matches; throws 404 when the prefix is wrong. Used by /library/meta,
 * /library/download, and DELETE /library to make sure `?path=` can't reach
 * into another workspace's subtree even if the caller owns that other
 * workspace too.
 */
export function requireLibraryPathInWorkspace(relPath: string, workspaceId: string): void {
  const expected = `library/${workspaceId}/`;
  if (!relPath.startsWith(expected)) {
    throw new NotFoundError(`File not found: ${relPath}`);
  }
}
