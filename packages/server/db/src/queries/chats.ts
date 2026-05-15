import { type Pool } from "../pool.js";
import {
  ChatSchema,
  GOAL_KEYS,
  ValidationError,
  type Chat,
  type GoalKey,
  type MessageKind,
} from "@agent-desk/shared";

function validateGoal(goal: string | null | undefined): GoalKey | null | undefined {
  if (goal === undefined) return undefined;
  if (goal === null) return null;
  if (!(GOAL_KEYS as readonly string[]).includes(goal)) {
    throw new ValidationError(`Invalid chat goal: ${goal}`);
  }
  return goal as GoalKey;
}

function rowToChat(row: Record<string, unknown>): Chat {
  return ChatSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    title: row.title,
    goal: row.goal ?? undefined,
    updatedAt: row.updated_at as string,
    // SQLite stores BOOLEAN as INTEGER 0/1; coerce at the boundary.
    awaitingUser: !!row.awaiting_user,
    unread: !!row.unread,
  });
}

export interface ChatWithLastMessage extends Chat {
  /** Kind that drives the chat-list icon when no chat goal is persisted. */
  kind: MessageKind;
  /**
   * True when the chat's most recent `agent_turn` message is pending/running.
   */
  running: boolean;
  /**
   * True when the chat's most recent `agent_turn` message failed and can be retried.
   */
  failed: boolean;
}

export async function listWithLatestMessage(
  db: Pool,
  workspaceId: string,
): Promise<ChatWithLastMessage[]> {
  const { rows } = await db.query(
    `SELECT c.*,
            c.list_kind AS kind,
            c.list_running AS is_running,
            c.list_failed AS is_failed
      FROM chats c
      WHERE c.workspace_id = ?
        AND c.list_internal = 0
      ORDER BY c.updated_at DESC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    ...rowToChat(r),
    kind: r.kind as MessageKind,
    running: !!r.is_running,
    failed: !!r.is_failed,
  }));
}

export async function findById(db: Pool, id: string): Promise<Chat | null> {
  const { rows } = await db.query("SELECT * FROM chats WHERE id = ?", [id]);
  return rows.length ? rowToChat(rows[0]) : null;
}

export async function insert(
  db: Pool,
  data: { id: string; workspaceId: string; agentId: string; title?: string; goal?: string },
): Promise<Chat> {
  const goal = validateGoal(data.goal);

  // Ensure the chat's agent is enabled in the workspace. This is the M3
  // invariant — chats can only use agents the user has explicitly added to
  // the workspace (or the workspace default).
  const { rows: checkRows } = await db.query(
    "SELECT 1 FROM workspace_agents WHERE workspace_id = ? AND agent_id = ?",
    [data.workspaceId, data.agentId],
  );
  if (checkRows.length === 0) {
    throw new ValidationError(
      `Agent ${data.agentId} is not enabled in workspace ${data.workspaceId}`,
    );
  }

  const { rows } = await db.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title, goal)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
    [data.id, data.workspaceId, data.agentId, data.title ?? "", goal ?? null],
  );
  return rowToChat(rows[0]);
}

export async function updateMeta(
  db: Pool,
  id: string,
  data: { title?: string; goal?: string | null; agentId?: string; unread?: boolean },
): Promise<Chat | null> {
  const goal = validateGoal(data.goal);

  if (data.agentId !== undefined) {
    // Preserve the M3 invariant enforced by insert(): a chat's agent must
    // be enabled in the chat's workspace. Look up the workspace via the
    // chat row so callers don't have to pass it.
    const { rows: chatRows } = await db.query(
      "SELECT workspace_id FROM chats WHERE id = ?",
      [id],
    );
    if (chatRows.length === 0) return null;
    const workspaceId = chatRows[0].workspace_id as string;
    const { rows: enabledRows } = await db.query(
      "SELECT 1 FROM workspace_agents WHERE workspace_id = ? AND agent_id = ?",
      [workspaceId, data.agentId],
    );
    if (enabledRows.length === 0) {
      throw new ValidationError(
        `Agent ${data.agentId} is not enabled in workspace ${workspaceId}`,
      );
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];

  if (data.title !== undefined) {
    sets.push(`title = ?`);
    params.push(data.title);
  }
  if (data.goal !== undefined) {
    sets.push(`goal = ?`);
    params.push(goal);
  }
  if (data.agentId !== undefined) {
    sets.push(`agent_id = ?`);
    params.push(data.agentId);
    // Atomically forget the opencode-serve session whenever the chat's
    // agent changes. The session was bound to the old agent's
    // providerID/modelID at creation time; opencode-serve ignores per-
    // sendMessage overrides for those fields, so reusing the session
    // would silently keep using the old model. Doing this in the same
    // UPDATE removes the race where a concurrent run could read the
    // new agent_id but still see the old session_id.
    sets.push(`opencode_session_id = NULL`);
  }
  if (data.unread !== undefined) {
    sets.push(`unread = ?`);
    params.push(data.unread ? 1 : 0);
  }

  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);

  params.push(id);
  const { rows } = await db.query(
    `UPDATE chats SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  return rows.length ? rowToChat(rows[0]) : null;
}

export async function markRead(db: Pool, id: string): Promise<Chat | null> {
  // Use RETURNING * so the caller gets an atomic snapshot of the chat row
  // immediately after clearing unread — no window for a concurrent
  // messages.insert to set unread=1 between the UPDATE and a separate SELECT.
  const { rows } = await db.query(
    "UPDATE chats SET unread = 0 WHERE id = ? RETURNING *",
    [id],
  );
  return rows.length ? rowToChat(rows[0]) : null;
}

export async function setAwaitingUser(
  db: Pool,
  id: string,
  awaiting: boolean,
): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE chats SET awaiting_user = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    [awaiting, id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Returns the opencode-serve session id bound to this chat, if any.
 * Each chat owns at most one session that turns are appended to. A null
 * return means the chat hasn't had its first turn yet under the new
 * runtime — the driver will create one and persist it via
 * `setOpencodeSessionId`.
 */
export async function getOpencodeSessionId(
  db: Pool,
  id: string,
): Promise<string | null> {
  const { rows } = await db.query(
    "SELECT opencode_session_id FROM chats WHERE id = ?",
    [id],
  );
  if (rows.length === 0) return null;
  const value = rows[0].opencode_session_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Writes (or clears) the opencode-serve session bound to a chat. We
 * intentionally don't bump `updated_at` here — this is internal runtime
 * metadata, not a user-visible event, and bumping the chat would shuffle
 * the chat-list ordering on every turn.
 */
export async function setOpencodeSessionId(
  db: Pool,
  id: string,
  sessionId: string | null,
): Promise<void> {
  await db.query(
    "UPDATE chats SET opencode_session_id = ? WHERE id = ?",
    [sessionId, id],
  );
}

/**
 * Clear the opencode-serve session id from every chat using a given agent.
 * Used when the agent's model changes — the existing daemon session is
 * bound to the prior model and won't honor the new one on subsequent
 * turns. Forgetting the id makes the next turn create a fresh session
 * with the current agent.model bound from the start.
 *
 * Returns the chat ids whose session was cleared so callers can
 * best-effort delete them on the daemon side too.
 */
export async function clearOpencodeSessionsForAgent(
  db: Pool,
  agentId: string,
): Promise<Array<{ chatId: string; previousSessionId: string }>> {
  const { rows } = await db.query<{ id: string; opencode_session_id: string | null }>(
    "SELECT id, opencode_session_id FROM chats WHERE agent_id = ? AND opencode_session_id IS NOT NULL",
    [agentId],
  );
  const cleared: Array<{ chatId: string; previousSessionId: string }> = [];
  for (const row of rows) {
    if (typeof row.opencode_session_id !== "string" || row.opencode_session_id.length === 0) continue;
    cleared.push({ chatId: row.id, previousSessionId: row.opencode_session_id });
  }
  if (cleared.length > 0) {
    await db.query(
      "UPDATE chats SET opencode_session_id = NULL WHERE agent_id = ?",
      [agentId],
    );
  }
  return cleared;
}

/**
 * Clear opencode-serve session ids for every chat owned by the user
 * (optionally scoped to a single workspace). Used when a user-level
 * connector or local source changes — the affected chats' sessions may
 * still be bound to the old auth/provider, so we forget the ids and let
 * the next turn create a fresh session against whatever is configured now.
 *
 * Returns the chat ids whose session was cleared.
 */
export async function clearOpencodeSessionsForUser(
  db: Pool,
  userId: string,
  workspaceId?: string,
): Promise<Array<{ chatId: string; previousSessionId: string }>> {
  const baseSelect = `SELECT c.id, c.opencode_session_id
       FROM chats c
       JOIN workspaces w ON w.id = c.workspace_id
      WHERE w.user_id = ?
        AND c.opencode_session_id IS NOT NULL`;
  const params: unknown[] = [userId];
  let sql = baseSelect;
  if (workspaceId) {
    sql += " AND c.workspace_id = ?";
    params.push(workspaceId);
  }
  const { rows } = await db.query<{ id: string; opencode_session_id: string | null }>(sql, params);
  const cleared: Array<{ chatId: string; previousSessionId: string }> = [];
  for (const row of rows) {
    if (typeof row.opencode_session_id !== "string" || row.opencode_session_id.length === 0) continue;
    cleared.push({ chatId: row.id, previousSessionId: row.opencode_session_id });
  }
  if (cleared.length > 0) {
    const updateSql = workspaceId
      ? `UPDATE chats SET opencode_session_id = NULL
          WHERE id IN (SELECT c.id FROM chats c
                        JOIN workspaces w ON w.id = c.workspace_id
                       WHERE w.user_id = ? AND c.workspace_id = ?)`
      : `UPDATE chats SET opencode_session_id = NULL
          WHERE id IN (SELECT c.id FROM chats c
                        JOIN workspaces w ON w.id = c.workspace_id
                       WHERE w.user_id = ?)`;
    const updateParams = workspaceId ? [userId, workspaceId] : [userId];
    await db.query(updateSql, updateParams);
  }
  return cleared;
}
