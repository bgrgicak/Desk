import { type Pool } from "../pool.js";
import {
  ChatSchema,
  GOAL_KEYS,
  ValidationError,
  type Chat,
  type GoalKey,
  type MessageKind,
} from "@agent-desk/shared";

function validateGoal(goal: string | undefined): GoalKey | undefined {
  if (goal === undefined) return undefined;
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
  lastMessageContent?: unknown;
  /**
   * Kind that drives the chat-list icon when no chat goal is persisted.
   * Newest message kind in the chat that represents a user action —
   * currently `task` and `task_run`. `chat` (conversation) and `ai_note`
   * (system-scheduled note refresh, auto-emitted on every turn) are both
   * treated as fallbacks so they don't hijack the icon. Falls back to
   * 'chat' when no user-action messages exist.
   */
  kind: MessageKind;
}

export async function listWithLatestMessage(
  db: Pool,
  workspaceId: string,
): Promise<ChatWithLastMessage[]> {
  const { rows } = await db.query(
    `SELECT c.*,
            (SELECT m.content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_content,
            COALESCE(
              (SELECT m.kind FROM messages m
                 WHERE m.chat_id = c.id AND m.kind NOT IN ('chat', 'ai_note')
                 ORDER BY m.created_at DESC LIMIT 1),
              'chat'
            ) AS kind
     FROM chats c
     WHERE c.workspace_id = ?
     ORDER BY c.updated_at DESC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    ...rowToChat(r),
    lastMessageContent: r.last_message_content ?? undefined,
    kind: r.kind as MessageKind,
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
  data: { title?: string; goal?: string; agentId?: string },
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
  }

  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);

  params.push(id);
  const { rows } = await db.query(
    `UPDATE chats SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  return rows.length ? rowToChat(rows[0]) : null;
}

export async function markRead(db: Pool, id: string): Promise<boolean> {
  // SQLite stores BOOLEAN as INTEGER 0/1.
  const { rowCount } = await db.query(
    "UPDATE chats SET unread = 0 WHERE id = ?",
    [id],
  );
  return (rowCount ?? 0) > 0;
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
