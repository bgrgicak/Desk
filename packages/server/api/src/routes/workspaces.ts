import { type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import {
  generateId,
  hubSlugForUser,
  isReservedWorkspaceSlug,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  slugifyWorkspaceName,
  type Workspace,
} from "@agent-desk/shared";
import { ensureWorkspaceLayout, renameWorkspaceDir, trashWorkspaceDir } from "@agent-desk/storage";
import { ensureDailyReflectionTasks } from "@agent-desk/scheduler";
import { withModule } from "@agent-desk/shared/logger";
const log = withModule("api/routes/workspaces");

const DEFAULT_AGENT_NAME = "Desk";
const DEFAULT_AGENT_MODEL = "anthropic/claude-haiku-4-5";

const HUB_NAME = "Hub";
const HUB_DESCRIPTION = "Your home base across all workspaces.";

export async function listWorkspaces(pool: Pool, userId?: string) {
  if (userId) return queries.workspaces.listByUser(pool, userId);
  return queries.workspaces.list(pool);
}

async function ensureWorkspaceAgent(pool: Pool, workspaceId: string, userId: string) {
  let activeAgents = await queries.agents.listActiveByUser(pool, userId);
  if (activeAgents.length === 0) {
    activeAgents = [await queries.agents.insert(pool, {
      id: generateId("agent"),
      userId,
      name: DEFAULT_AGENT_NAME,
      model: DEFAULT_AGENT_MODEL,
    })];
  }
  for (const agent of activeAgents) {
    await queries.workspaceAgents.addToWorkspace(pool, workspaceId, agent.id);
  }
  return queries.workspaceAgents.listForWorkspace(pool, workspaceId);
}

/**
 * Creates the per-user hub workspace. The slug shape is
 * `{user-slug}-hub` so the user can identify the hub by name when
 * browsing the host filesystem; the suffix is in the reserved-slug list
 * so users cannot create or rename a workspace into this slot.
 *
 * Idempotent — if the user already has a hub, returns it. Internal
 * server code is the only allowed caller of this function; the API
 * never accepts a `kind` parameter.
 */
export async function createHub(
  pool: Pool,
  home: string,
  userId: string,
  userSlug: string,
): Promise<Workspace> {
  const existing = await queries.workspaces.findHubByUser(pool, userId);
  let ws: Workspace;
  if (existing) {
    ws = existing;
  } else {
    const slug = hubSlugForUser(userSlug);
    await ensureWorkspaceLayout(home, slug);
    ws = await queries.workspaces.insert(pool, {
      id: generateId("workspace"),
      userId,
      name: HUB_NAME,
      description: HUB_DESCRIPTION,
      path: slug,
      kind: "hub",
    });
    await ensureWorkspaceAgent(pool, ws.id, userId);
  }

  if ((process.env.DESK_DAILY_REFLECTION ?? "on").toLowerCase() !== "off") {
    await ensureDailyReflectionTasks({
      pool,
      cron: process.env.DESK_DAILY_REFLECTION_CRON ?? "0 3 * * *",
    });
  }
  return ws;
}

/**
 * Walks every user and ensures a hub workspace exists. Called from the
 * server boot pass so existing users predating the hub feature get one
 * on next start, and any user whose hub was deleted via direct DB access
 * gets it re-created. Idempotent.
 *
 * Errors from one user's hub creation (slug collision with another user's
 * existing workspace, FS permission issues, etc.) are logged and the loop
 * continues — one bad row should not block every later user from getting
 * a hub on this boot.
 */
export async function ensureHubsForAllUsers(pool: Pool, home: string): Promise<void> {
  const { rows } = await pool.query<{ id: string; username: string }>(
    `SELECT id, username FROM users`,
  );
  for (const row of rows) {
    try {
      await createHub(pool, home, row.id, row.username);
    } catch (err) {
      log.error(
        `ensureHubsForAllUsers: failed to create hub for user ${row.id} (${row.username}): ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Creates a workspace and ensures it has at least one enrolled agent. If the
 * caller has no agents yet, creates a default opencode-backed agent first.
 * Without this, chat creation would 400 on every agentId in the new workspace.
 * Users can override the enrollment via the Agent access settings panel.
 *
 * The workspace's on-disk directory at `~/Desk/{slug}/` is
 * created before the DB insert so every successful insert has a matching
 * folder. Slug is derived from `name` with a `-2`, `-3`, ... suffix on
 * collision so two workspaces can't share a directory.
 *
 * The API never accepts a `kind` parameter — every API-created workspace
 * is `project`. The slug is also checked against the reserved-suffix list
 * so a user can't impersonate another user's `-hub` slot. Both rules are
 * the user-facing safety net behind the DB constraints.
 */
export async function createWorkspace(
  pool: Pool,
  userId: string,
  home: string,
  data: { name: string; description?: string; icon?: string; color?: string },
) {
  const path = await queries.workspaces.reserveWorkspacePath(pool, data.name);
  if (isReservedWorkspaceSlug(path)) {
    throw new ValidationError(
      `Workspace name resolves to a reserved slug "${path}"; pick a different name.`,
    );
  }
  await ensureWorkspaceLayout(home, path);
  const ws = await queries.workspaces.insert(pool, {
    id: generateId("workspace"),
    userId,
    path,
    ...data,
  });
  await ensureWorkspaceAgent(pool, ws.id, userId);
  if ((process.env.DESK_DAILY_REFLECTION ?? "on").toLowerCase() !== "off") {
    await ensureDailyReflectionTasks({
      pool,
      cron: process.env.DESK_DAILY_REFLECTION_CRON ?? "0 3 * * *",
    });
  }
  return ws;
}

export async function getWorkspace(pool: Pool, id: string) {
  const ws = await queries.workspaces.findById(pool, id);
  if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
  return ws;
}

/**
 * Updates workspace metadata. When `name` changes, computes a new slug
 * from the new name; if it differs from the current slug and is free,
 * renames the on-disk directory and updates the `path` column to match.
 * All other changes are pure metadata and skip the filesystem op.
 *
 * Renames into a reserved suffix are rejected so a user can't take over
 * an internal slot. Hubs themselves cannot be renamed via this endpoint
 * (the hub's slug is part of how the user identifies their slice on
 * disk; allowing renames would break that landmark).
 */
export async function patchWorkspace(
  pool: Pool,
  home: string,
  id: string,
  data: { name?: string; description?: string; icon?: string; color?: string },
) {
  const current = await queries.workspaces.findById(pool, id);
  if (!current) throw new NotFoundError(`Workspace not found: ${id}`);

  let newPath: string | undefined;
  if (data.name !== undefined && data.name !== current.name) {
    if (current.kind === "hub") {
      throw new ForbiddenError("The hub workspace cannot be renamed.");
    }
    const desired = slugifyWorkspaceName(data.name);
    if (desired !== current.path) {
      newPath = await queries.workspaces.reserveWorkspacePath(pool, data.name, id);
      if (isReservedWorkspaceSlug(newPath)) {
        throw new ValidationError(
          `Workspace name resolves to a reserved slug "${newPath}"; pick a different name.`,
        );
      }
      await renameWorkspaceDir(home, current.path, newPath);
    }
  }

  const ws = await queries.workspaces.updateMeta(pool, id, {
    ...data,
    ...(newPath ? { path: newPath } : {}),
  });
  if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
  return ws;
}

/**
 * Hard-deletes a workspace (FK cascade removes chats/messages/workspace_agents)
 * and moves its on-disk directory into `~/Desk/.trash/workspaces/`.
 * Refuses to delete the user's last *project* workspace — the app
 * requires at least one (the hub doesn't satisfy this because the hub
 * has different capabilities and isn't a substitute for a project
 * workspace). The hub itself is non-deletable via this endpoint; if
 * deleted via direct DB access, the boot pass recreates it.
 */
export async function deleteWorkspace(
  pool: Pool,
  home: string,
  userId: string,
  id: string,
) {
  const ws = await queries.workspaces.findById(pool, id);
  if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
  if (ws.kind === "hub") {
    throw new ForbiddenError("The hub workspace cannot be deleted.");
  }
  const owned = await queries.workspaces.listByUser(pool, userId);
  const projectCount = owned.filter((w) => w.kind === "project").length;
  if (projectCount <= 1) {
    throw new ValidationError(
      "Cannot delete the last workspace; create another one first.",
    );
  }
  await pool.query(`DELETE FROM workspaces WHERE id = ?`, [id]);
  await trashWorkspaceDir(home, ws.path).catch(() => {
    // Best-effort; DB state is already gone.
  });
  return { ok: true };
}

/** Lists globally active agents available in a workspace, ordered by model order. */
export async function listWorkspaceAgents(pool: Pool, workspaceId: string) {
  const ws = await queries.workspaces.findById(pool, workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  const memberships = await ensureWorkspaceAgent(pool, workspaceId, ws.userId);
  const agents = await Promise.all(
    memberships.map(async (m) => {
      const agent = await queries.agents.findById(pool, m.agentId);
      return agent ? { ...agent, addedAt: m.addedAt } : null;
    }),
  );
  return agents.filter((a): a is NonNullable<typeof a> => a !== null);
}

/** Adds an agent to a workspace. Validates that the agent belongs to the workspace's owner. */
export async function addAgentToWorkspace(
  pool: Pool,
  workspaceId: string,
  agentId: string,
) {
  const ws = await queries.workspaces.findById(pool, workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${workspaceId}`);
  const agent = await queries.agents.findById(pool, agentId);
  if (!agent) throw new NotFoundError(`Agent not found: ${agentId}`);
  if (!agent.enabled) throw new ValidationError("Cannot add an inactive model to a workspace");
  if (agent.userId !== ws.userId) {
    throw new ValidationError(
      "Agent owner does not match workspace owner; cannot add to workspace",
    );
  }
  return queries.workspaceAgents.addToWorkspace(pool, workspaceId, agentId);
}

export async function removeAgentFromWorkspace(
  pool: Pool,
  workspaceId: string,
  agentId: string,
) {
  const memberships = await queries.workspaceAgents.listForWorkspace(pool, workspaceId);
  if (memberships.length <= 1 && memberships.some((m) => m.agentId === agentId)) {
    throw new ValidationError(
      "Cannot remove the last agent from a workspace; add another agent first.",
    );
  }
  await queries.workspaceAgents.removeFromWorkspace(pool, workspaceId, agentId);
  return { ok: true };
}
