import pg from "pg";
import { ChatSchema, ValidationError, type Chat } from "@desk/shared";

type Queryable = pg.Pool | pg.PoolClient;

function rowToChat(row: Record<string, unknown>): Chat {
  return ChatSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    title: row.title,
    goal: row.goal ?? undefined,
    updatedAt: (row.updated_at as Date).toISOString(),
    awaitingUser: row.awaiting_user,
    unread: row.unread,
  });
}

export interface ChatWithLastMessage extends Chat {
  lastMessageContent?: unknown;
}

export async function listWithLatestMessage(
  db: Queryable,
  workspaceId: string,
): Promise<ChatWithLastMessage[]> {
  const { rows } = await db.query(
    `SELECT c.*,
            (SELECT m.content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_content
     FROM chats c
     WHERE c.workspace_id = $1
     ORDER BY c.updated_at DESC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    ...rowToChat(r),
    lastMessageContent: r.last_message_content ?? undefined,
  }));
}

export async function findById(db: Queryable, id: string): Promise<Chat | null> {
  const { rows } = await db.query("SELECT * FROM chats WHERE id = $1", [id]);
  return rows.length ? rowToChat(rows[0]) : null;
}

export async function insert(
  db: Queryable,
  data: { id: string; workspaceId: string; agentId: string; title?: string; goal?: string },
): Promise<Chat> {
  // Ensure the chat's agent is enabled in the workspace. This is the M3
  // invariant — chats can only use agents the user has explicitly added to
  // the workspace (or the workspace default).
  const { rows: checkRows } = await db.query(
    "SELECT 1 FROM workspace_agents WHERE workspace_id = $1 AND agent_id = $2",
    [data.workspaceId, data.agentId],
  );
  if (checkRows.length === 0) {
    throw new ValidationError(
      `Agent ${data.agentId} is not enabled in workspace ${data.workspaceId}`,
    );
  }

  const { rows } = await db.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title, goal)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [data.id, data.workspaceId, data.agentId, data.title ?? "", data.goal ?? null],
  );
  return rowToChat(rows[0]);
}

export async function updateMeta(
  db: Queryable,
  id: string,
  data: { title?: string; goal?: string; agentId?: string },
): Promise<Chat | null> {
  if (data.agentId !== undefined) {
    // Preserve the M3 invariant enforced by insert(): a chat's agent must
    // be enabled in the chat's workspace. Look up the workspace via the
    // chat row so callers don't have to pass it.
    const { rows: chatRows } = await db.query(
      "SELECT workspace_id FROM chats WHERE id = $1",
      [id],
    );
    if (chatRows.length === 0) return null;
    const workspaceId = chatRows[0].workspace_id as string;
    const { rows: enabledRows } = await db.query(
      "SELECT 1 FROM workspace_agents WHERE workspace_id = $1 AND agent_id = $2",
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
  let idx = 1;

  if (data.title !== undefined) {
    sets.push(`title = $${idx++}`);
    params.push(data.title);
  }
  if (data.goal !== undefined) {
    sets.push(`goal = $${idx++}`);
    params.push(data.goal);
  }
  if (data.agentId !== undefined) {
    sets.push(`agent_id = $${idx++}`);
    params.push(data.agentId);
  }

  sets.push(`updated_at = now()`);

  params.push(id);
  const { rows } = await db.query(
    `UPDATE chats SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return rows.length ? rowToChat(rows[0]) : null;
}

export async function markRead(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE chats SET unread = false WHERE id = $1",
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export async function setAwaitingUser(
  db: Queryable,
  id: string,
  awaiting: boolean,
): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE chats SET awaiting_user = $1, updated_at = now() WHERE id = $2",
    [awaiting, id],
  );
  return (rowCount ?? 0) > 0;
}
