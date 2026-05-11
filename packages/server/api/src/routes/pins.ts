import { type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import {
  ForbiddenError,
  generateId,
  NotFoundError,
  PIN_KINDS,
  ValidationError,
  type Pin,
  type PinKind,
} from "@agent-desk/shared";
import { requireOwnedWorkspace } from "../auth/ownership.js";

/**
 * Cross-workspace pinning. Lives on the hub workspace today and is gated
 * to `kind === 'hub'` at the route layer — project workspaces have no
 * use for cross-workspace references and the spec requires the
 * separation. The pin record stores a reference (kind + ref id) into a
 * source workspace; the underlying item is not copied.
 */

function ensureHubWorkspace(workspace: { kind: "project" | "hub" }): void {
  if (workspace.kind !== "hub") {
    throw new ForbiddenError(
      "Cross-workspace pinning is only available on the hub workspace.",
    );
  }
}

export async function listPins(
  pool: Pool,
  workspaceId: string,
  userId: string,
): Promise<Pin[]> {
  const ws = await queries.workspaces.findById(pool, workspaceId);
  if (!ws || ws.userId !== userId) {
    throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  }
  ensureHubWorkspace(ws);
  return queries.pins.listByWorkspace(pool, workspaceId);
}

export async function createPin(
  pool: Pool,
  workspaceId: string,
  userId: string,
  data: { sourceWorkspaceId: string; kind: PinKind; refId: string },
): Promise<Pin> {
  const ws = await queries.workspaces.findById(pool, workspaceId);
  if (!ws || ws.userId !== userId) {
    throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  }
  ensureHubWorkspace(ws);

  if (!PIN_KINDS.includes(data.kind)) {
    throw new ValidationError(`Invalid pin kind: ${data.kind}`);
  }
  if (!data.refId || typeof data.refId !== "string") {
    throw new ValidationError("Missing or invalid refId");
  }
  if (!data.sourceWorkspaceId || typeof data.sourceWorkspaceId !== "string") {
    throw new ValidationError("Missing or invalid sourceWorkspaceId");
  }

  // The source workspace must be one the user owns. This is the
  // pin_cross_workspace capability check: the hub may pin items from
  // any owned workspace, but never from someone else's.
  await requireOwnedWorkspace(pool, data.sourceWorkspaceId, userId);

  // Idempotent: if the same (workspace, kind, source, ref) already
  // exists, return it instead of raising on the unique constraint.
  const existing = await queries.pins.findExisting(pool, {
    workspaceId,
    sourceWorkspaceId: data.sourceWorkspaceId,
    kind: data.kind,
    refId: data.refId,
  });
  if (existing) return existing;

  return queries.pins.insert(pool, {
    id: generateId("pin"),
    workspaceId,
    sourceWorkspaceId: data.sourceWorkspaceId,
    kind: data.kind,
    refId: data.refId,
  });
}

export async function deletePin(
  pool: Pool,
  workspaceId: string,
  userId: string,
  pinId: string,
): Promise<{ ok: boolean }> {
  const ws = await queries.workspaces.findById(pool, workspaceId);
  if (!ws || ws.userId !== userId) {
    throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  }
  ensureHubWorkspace(ws);
  const removed = await queries.pins.deleteById(pool, workspaceId, pinId);
  if (!removed) throw new NotFoundError(`Pin not found: ${pinId}`);
  return { ok: true };
}
