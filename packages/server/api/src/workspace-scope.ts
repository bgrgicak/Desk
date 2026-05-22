import { type Pool } from "@roomy-ai/db";
import { NotFoundError, ValidationError } from "@roomy-ai/shared";
import { queries } from "@roomy-ai/db";
import { validateLibrarySubpath, validateReadableSubpath } from "@roomy-ai/storage";
import { requireOwnedChat, requireOwnedWorkspace } from "./auth/ownership.js";

const WORKSPACE_ID_PATTERN = /^wks_[A-Za-z0-9_-]+$/;

/**
 * Workspace scope of an authenticated request. Threaded from the request
 * entry point through every downstream query so endpoints never re-derive
 * scope from user input — user-supplied IDs can only narrow the scope, not
 * widen it.
 *
 * - `single` — request may only access data belonging to one workspace.
 *   This is the scope for every project-workspace request (and the scope
 *   a hub request gets when it explicitly narrows to a single workspace).
 * - `owned` — request may access data from any workspace where
 *   `workspace.user_id = userId`. Granted only when the requesting
 *   workspace's `kind === 'hub'`. Both forms carry `userId`; `owned` just
 *   omits the per-workspace filter, it never relaxes the per-user filter.
 */
export type WorkspaceScope =
  | { kind: "single"; userId: string; workspaceId: string }
  | { kind: "owned"; userId: string };

/**
 * Resolves a request's workspace scope from the `?workspaceId=` query
 * param. The kind of the resolved workspace drives the scope: `hub`
 * workspaces get `{ kind: 'owned' }` (cross-workspace reach for the
 * single requesting user); `project` workspaces get `{ kind: 'single' }`
 * narrowed to that one workspace.
 *
 * No implicit fallback — callers must either supply `workspaceId` or
 * handle the missing case explicitly. The old "use the first workspace"
 * shortcut was removed once the hub started sorting first; without an
 * explicit param, the hub would silently widen every legacy call.
 */
export async function resolveWorkspaceScope(
  pool: Pool,
  userId: string,
  query: URLSearchParams,
): Promise<WorkspaceScope | null> {
  const q = query.get("workspaceId");
  if (q === null || q === "") return null;
  if (!WORKSPACE_ID_PATTERN.test(q)) {
    throw new ValidationError(`Invalid workspaceId: ${q}`);
  }
  await requireOwnedWorkspace(pool, q, userId);
  const ws = await queries.workspaces.findById(pool, q);
  if (!ws) throw new NotFoundError(`Workspace not found: ${q}`);
  if (ws.kind === "hub") {
    return { kind: "owned", userId };
  }
  return { kind: "single", userId, workspaceId: q };
}

/**
 * Like `resolveWorkspaceScope` but throws when no workspace is supplied.
 * Used by mutating endpoints (POST/DELETE) where the operation has to
 * land somewhere.
 */
export async function requireWorkspaceScope(
  pool: Pool,
  userId: string,
  query: URLSearchParams,
): Promise<WorkspaceScope> {
  const scope = await resolveWorkspaceScope(pool, userId, query);
  if (!scope) throw new NotFoundError("No workspace available");
  return scope;
}

/**
 * Compatibility helper for endpoints that operate on a single workspace
 * (chats, library files, etc.). Returns the explicit workspaceId from the
 * query param, regardless of whether the workspace is a hub or project. The
 * hub is a valid single workspace for CRUD purposes; `owned` (cross-workspace)
 * scope is only meaningful for sandbox search endpoints, which derive scope
 * from the sandbox token rather than from this helper.
 */
export async function resolveWorkspaceId(
  pool: Pool,
  userId: string,
  query: URLSearchParams,
): Promise<string | null> {
  const scope = await resolveWorkspaceScope(pool, userId, query);
  if (!scope) return null;
  if (scope.kind === "owned") {
    // Hub workspace: the caller explicitly supplied the hub's workspaceId.
    // Return it so single-workspace endpoints (chats, library, …) operate on
    // the hub's own data. Cross-workspace expansion only applies to sandbox
    // endpoints, which derive scope from the sandbox token, not this helper.
    return query.get("workspaceId")!;
  }
  return scope.workspaceId;
}

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
  _workspaceId: string,
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
