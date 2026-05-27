import { type Pool } from "@roomy-ai/db";
import { queries } from "@roomy-ai/db";
import {
  generateId,
  hubSlugForUser,
  isReservedWorkspaceSlug,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  slugifyWorkspaceName,
  type Chat,
  type Workspace,
} from "@roomy-ai/shared";
import { ensureWorkspaceLayout, renameWorkspaceDir, trashWorkspaceDir } from "@roomy-ai/storage";
import { ensureDailyReflectionTasks } from "@roomy-ai/scheduler";
import { withModule } from "@roomy-ai/shared/logger";
const log = withModule("api/routes/workspaces");

const HUB_NAME = "Hub";
const HUB_DESCRIPTION = "Your home base across all workspaces.";

/**
 * Lists workspaces for a user. The hub workspace is included so clients
 * can look up its metadata (path, name) when rendering hub-based chats
 * and threads. Clients that want only project workspaces should filter by
 * `kind !== "hub"` themselves (e.g. workspace pickers, sidebar room lists,
 * and the "first workspace" navigation fallback). Rename and delete remain
 * blocked by separate `kind === "hub"` guards in this file.
 */
export async function listWorkspaces(pool: Pool, userId?: string) {
  const rows = userId
    ? await queries.workspaces.listByUser(pool, userId)
    : await queries.workspaces.list(pool);
  return rows;
}

/**
 * Enrolls the user's existing active agents into the workspace. Does NOT
 * create an agent when the user has none — a fresh user must explicitly
 * add a model through the onboarding "Add AI providers" step. Auto-creating
 * here would render in onboarding as if the user already configured a
 * provider, which misleads them about what credentials/state exists on
 * their behalf.
 */
async function enrollExistingAgents(pool: Pool, workspaceId: string, userId: string) {
  const activeAgents = await queries.agents.listActiveByUser(pool, userId);
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
    await enrollExistingAgents(pool, ws.id, userId);
  }

  if ((process.env.ROOMY_DAILY_REFLECTION ?? "on").toLowerCase() !== "off") {
    await ensureDailyReflectionTasks({
      pool,
      cron: process.env.ROOMY_DAILY_REFLECTION_CRON ?? "0 3 * * *",
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

const ASK_AI_CHAT_TITLE = "Ask AI";

/**
 * Returns the user's "Ask AI" chat — the dedicated hub-workspace chat
 * titled `"Ask AI"`, created on demand. The hub itself is not exposed
 * via the public workspaces API (filtered out of `listWorkspaces`,
 * treated as 404 by `requireOwnedWorkspace`), so this is the dedicated
 * seam for the Home → Ask AI surface to discover its chat id without
 * leaking the hub workspaceId to client logic.
 *
 * Lookup is by title rather than "oldest in hub": the hub also hosts
 * internal task_run chats (daily reflections, future automation), and
 * those routinely land first — so a positional pick would silently
 * hand the user a system chat full of `reflection_request` plumbing.
 * Title is the explicit primitive that matches the surface's intent.
 */
export async function getOrCreateAskAiChat(pool: Pool, userId: string): Promise<Chat> {
  const hub = await queries.workspaces.findHubByUser(pool, userId);
  if (!hub) throw new NotFoundError("Hub workspace not provisioned for user");

  const existing = await queries.chats.findByWorkspaceAndTitle(pool, hub.id, ASK_AI_CHAT_TITLE);
  if (existing) return existing;

  const memberships = await enrollExistingAgents(pool, hub.id, userId);
  const agentId = memberships[0]?.agentId;
  if (!agentId) throw new NotFoundError("No agent available for hub workspace");

  return queries.chats.insert(pool, {
    id: generateId("chat"),
    workspaceId: hub.id,
    agentId,
    title: ASK_AI_CHAT_TITLE,
  });
}

/**
 * Creates a workspace and enrolls the user's existing active agents. If the
 * caller has no agents yet, the workspace starts empty — chat creation in
 * that workspace will 400 until the user adds a model through the global
 * Models settings tab. This is by design: silently provisioning an agent
 * here would render in onboarding as a pre-configured provider the user
 * didn't add.
 *
 * The workspace's on-disk directory at `~/Roomy/{slug}/` is
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
  await enrollExistingAgents(pool, ws.id, userId);
  if ((process.env.ROOMY_DAILY_REFLECTION ?? "on").toLowerCase() !== "off") {
    await ensureDailyReflectionTasks({
      pool,
      cron: process.env.ROOMY_DAILY_REFLECTION_CRON ?? "0 3 * * *",
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
 * and moves its on-disk directory into `~/Roomy/.trash/workspaces/`.
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
  const memberships = await enrollExistingAgents(pool, workspaceId, ws.userId);
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
