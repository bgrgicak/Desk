import { type Pool } from "@agent-desk/db";
import { NotFoundError, ValidationError } from "@agent-desk/shared";
import { queries } from "@agent-desk/db";
import { validateLibrarySubpath, validateReadableSubpath } from "@agent-desk/storage";
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
 * unsafe characters so endpoints that accept a `?path=` cannot escape
 * the workspace.
 *
 * Dot-prefixed (hidden) segments are allowed — hidden files are regular
 * files whose only special behavior is being excluded from listing /
 * search results unless `showHidden` is set.
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
 * Path validator for read endpoints that also serves user-uploaded chat
 * attachments, materialized chat summaries, and chat artifacts. Accepts
 * library paths (including hidden dot-prefixed paths) and special
 * `.chats/<chatId>/...` sub-paths after verifying the caller owns the
 * chat.
 */
const CHAT_ATTACHMENT_PATTERN =
  /^\.chats\/(cht_[A-Za-z0-9_-]+)\/attachments\/([^/]+)$/;
const CHAT_SUMMARY_PATTERN =
  /^\.chats\/(cht_[A-Za-z0-9_-]+)\/notes\/([^/]+\.md)$/;
const CHAT_ARTIFACT_PATTERN =
  /^\.chats\/(cht_[A-Za-z0-9_-]+)\/artifacts\/(.+)$/;

export function parseReadableChatArtifactPath(relPath: string): { chatId: string } | null {
  const artifact = relPath.match(CHAT_ARTIFACT_PATTERN);
  if (!artifact) return null;
  if (relPath.includes("\0") || relPath.includes("\\")) {
    throw new NotFoundError(`File not found: ${relPath}`);
  }
  const artifactPath = artifact[2];
  const segments = artifactPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new NotFoundError(`File not found: ${relPath}`);
  }
  return { chatId: artifact[1] };
}

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
  const summary = relPath.match(CHAT_SUMMARY_PATTERN);
  if (summary) {
    await requireOwnedChat(pool, summary[1], userId);
    return;
  }
  const artifact = parseReadableChatArtifactPath(relPath);
  if (artifact) {
    await requireOwnedChat(pool, artifact.chatId, userId);
    return;
  }
  // Validate the path — blocks traversal (`..`), backslashes, empty
  // segments, and null bytes. Dot-prefixed (hidden) paths are allowed.
  try {
    validateReadableSubpath(relPath);
  } catch {
    throw new NotFoundError(`File not found: ${relPath}`);
  }
}
