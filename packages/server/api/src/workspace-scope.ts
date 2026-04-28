import { type Pool, type PoolClient } from "@desk/db";
import { NotFoundError, ValidationError } from "@desk/shared";
import { queries } from "@desk/db";
import { validateLibrarySubpath } from "@desk/storage";
import { requireOwnedChat, requireOwnedWorkspace } from "./auth/ownership.js";

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
  pool: Pool,
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
  pool: Pool,
  userId: string,
  query: URLSearchParams,
): Promise<string> {
  const wsId = await resolveWorkspaceId(pool, userId, query);
  if (!wsId) throw new NotFoundError("No workspace available");
  return wsId;
}

/**
 * Validates a user-supplied library path at the API boundary.
 *
 * Under the workspace-as-home model the workspace root IS the library —
 * all user-visible content lives under it without a per-workspace
 * prefix. This check rejects traversal (`..`), absolute paths, and
 * dot-prefixed (infrastructure) segments so endpoints that accept a
 * `?path=` cannot reach into `.chats/` or escape the workspace.
 *
 * Still takes `workspaceId` for forward-compatibility with a future
 * multi-workspace layout; it is not used today.
 */
export function requireLibraryPathInWorkspace(relPath: string, _workspaceId: string): void {
  try {
    validateLibrarySubpath(relPath);
  } catch {
    throw new NotFoundError(`File not found: ${relPath}`);
  }
}

/**
 * Path validator for read endpoints that should also serve user-uploaded
 * chat attachments and materialized chat notes. Accepts strict library
 * paths (delegates to `requireLibraryPathInWorkspace`),
 * `.chats/<chatId>/attachments/<filename>` (uploads), and
 * `.chats/<chatId>/notes/<messageId>.md` (note mirrors), after verifying
 * the caller owns the chat. Other dot-prefixed paths (e.g. `logs/`)
 * remain blocked so this can't be used to traverse agent infrastructure.
 */
const CHAT_ATTACHMENT_PATTERN =
  /^\.chats\/(cht_[A-Za-z0-9_-]+)\/attachments\/([^/]+)$/;
const CHAT_NOTE_PATTERN =
  /^\.chats\/(cht_[A-Za-z0-9_-]+)\/notes\/([^/]+\.md)$/;

export async function requireReadablePathInWorkspace(
  pool: Pool,
  userId: string,
  relPath: string,
  workspaceId: string,
): Promise<void> {
  const att = relPath.match(CHAT_ATTACHMENT_PATTERN);
  if (att) {
    await requireOwnedChat(pool, att[1], userId);
    return;
  }
  const note = relPath.match(CHAT_NOTE_PATTERN);
  if (note) {
    await requireOwnedChat(pool, note[1], userId);
    return;
  }
  requireLibraryPathInWorkspace(relPath, workspaceId);
}
