import pg from "pg";
import { MessageSchema, type Message } from "@desk/shared";

type Queryable = pg.Pool | pg.PoolClient;

function rowToMessage(row: Record<string, unknown>): Message {
  return MessageSchema.parse({
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    content: row.content,
    createdAt: (row.created_at as Date).toISOString(),
    executeAt: row.execute_at ? (row.execute_at as Date).toISOString() : undefined,
    cron: row.cron ?? undefined,
    state: row.state ?? undefined,
    parentId: row.parent_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    schedulerRef: row.scheduler_ref ?? undefined,
    startedAt: row.started_at ? (row.started_at as Date).toISOString() : undefined,
    endedAt: row.ended_at ? (row.ended_at as Date).toISOString() : undefined,
    updatedAt: row.updated_at ? (row.updated_at as Date).toISOString() : undefined,
  });
}

export interface PaginatedMessages {
  items: Message[];
  nextCursor?: string;
}

export async function listByChat(
  db: Queryable,
  chatId: string,
  opts?: { cursor?: string; limit?: number },
): Promise<PaginatedMessages> {
  const limit = opts?.limit ?? 50;
  const params: unknown[] = [chatId, limit + 1];
  let whereClause = "chat_id = $1";

  if (opts?.cursor) {
    whereClause += " AND created_at > $3";
    params.push(new Date(opts.cursor));
  }

  const { rows } = await db.query(
    `SELECT * FROM messages WHERE ${whereClause} ORDER BY created_at LIMIT $2`,
    params,
  );

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(rowToMessage);
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1].createdAt : undefined,
  };
}

export async function insert(
  db: Queryable,
  data: {
    id: string;
    chatId: string;
    role: string;
    content: unknown;
    state?: string | null;
    executeAt?: string | null;
    cron?: string | null;
    parentId?: string | null;
    agentId?: string | null;
    schedulerRef?: unknown;
  },
): Promise<Message> {
  const { rows } = await db.query(
    `INSERT INTO messages (
       id, chat_id, role, content,
       state, execute_at, cron, parent_id, agent_id, scheduler_ref
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      data.id,
      data.chatId,
      data.role,
      JSON.stringify(data.content),
      data.state ?? null,
      data.executeAt ? new Date(data.executeAt) : null,
      data.cron ?? null,
      data.parentId ?? null,
      data.agentId ?? null,
      data.schedulerRef ? JSON.stringify(data.schedulerRef) : null,
    ],
  );
  // Touch the parent chat's updated_at
  await db.query("UPDATE chats SET updated_at = now(), unread = true WHERE id = $1", [data.chatId]);
  return rowToMessage(rows[0]);
}

export async function findById(db: Queryable, id: string): Promise<Message | null> {
  const { rows } = await db.query("SELECT * FROM messages WHERE id = $1", [id]);
  return rows.length ? rowToMessage(rows[0]) : null;
}

/**
 * Transitions a message from pending → running atomically. Returns true if
 * the message was picked up (we own it), false if it was already running,
 * terminal, or missing. This is the central idempotence point for the
 * fire handler: concurrent attempts to fire the same message converge
 * on one execution.
 */
export async function claimPending(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE messages
     SET state = 'running', started_at = now(), updated_at = now()
     WHERE id = $1 AND state = 'pending'`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Marks a running message as succeeded or failed. Cron-root messages stay
 * in "pending" after firing (they're always-active schedules), so callers
 * opt in explicitly.
 */
export async function finalizeExecution(
  db: Queryable,
  id: string,
  terminalState: "succeeded" | "failed" | "cancelled",
): Promise<Message | null> {
  const { rows } = await db.query(
    `UPDATE messages
     SET state = $1, ended_at = now(), updated_at = now()
     WHERE id = $2
     RETURNING *`,
    [terminalState, id],
  );
  return rows.length ? rowToMessage(rows[0]) : null;
}

/**
 * PATCH-style content/state update. Any field left undefined is preserved.
 * Returns the updated row, or null if not found.
 */
export async function updateMessage(
  db: Queryable,
  id: string,
  patch: { content?: unknown; state?: string; executeAt?: string | null; cron?: string | null },
): Promise<Message | null> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [];
  let idx = 1;
  if (patch.content !== undefined) {
    sets.push(`content = $${idx++}`);
    params.push(JSON.stringify(patch.content));
  }
  if (patch.state !== undefined) {
    sets.push(`state = $${idx++}`);
    params.push(patch.state);
  }
  if (patch.executeAt !== undefined) {
    sets.push(`execute_at = $${idx++}`);
    params.push(patch.executeAt === null ? null : new Date(patch.executeAt));
  }
  if (patch.cron !== undefined) {
    sets.push(`cron = $${idx++}`);
    params.push(patch.cron);
  }
  params.push(id);
  const { rows } = await db.query(
    `UPDATE messages SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return rows.length ? rowToMessage(rows[0]) : null;
}

/** Lists pending scheduled messages across all chats (for boot reconcile). */
export async function listPendingScheduled(db: Queryable): Promise<Message[]> {
  const { rows } = await db.query(
    `SELECT * FROM messages
     WHERE state = 'pending' AND (execute_at IS NOT NULL OR cron IS NOT NULL)
     ORDER BY execute_at NULLS LAST`,
  );
  return rows.map(rowToMessage);
}
