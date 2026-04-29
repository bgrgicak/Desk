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
    attachments: row.attachments ?? undefined,
    model: row.model ?? undefined,
    executeAt: row.execute_at ? (row.execute_at as Date).toISOString() : undefined,
    cron: row.cron ?? undefined,
    state: row.state ?? undefined,
    parentId: row.parent_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    schedulerRef: row.scheduler_ref ?? undefined,
    startedAt: row.started_at ? (row.started_at as Date).toISOString() : undefined,
    endedAt: row.ended_at ? (row.ended_at as Date).toISOString() : undefined,
    updatedAt: row.updated_at ? (row.updated_at as Date).toISOString() : undefined,
    kind: row.kind ?? "chat",
    title: row.title ?? null,
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
    attachments?: unknown;
    model?: string | null;
    kind?: string | null;
    title?: string | null;
  },
): Promise<Message> {
  const { rows } = await db.query(
    `INSERT INTO messages (
       id, chat_id, role, content,
       state, execute_at, cron, parent_id, agent_id, scheduler_ref,
       attachments, model, kind, title
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
      data.attachments ? JSON.stringify(data.attachments) : null,
      data.model ?? null,
      data.kind ?? "chat",
      data.title ?? null,
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
 * Atomically starts a new task_run row as a child of the task message.
 * Locks the task FOR UPDATE, refuses if another task_run for the same task
 * is already pending or running (so concurrent fires of the same task
 * converge on one in-flight run), and inserts the new row directly in
 * `running` state with `started_at = now()`. Returns the run row, or null
 * if the task is missing / not a task / already firing.
 *
 * Pool-only: opens a dedicated client for the transaction. Don't pass a
 * PoolClient here — the lock has to be held end-to-end on one connection.
 */
export async function startTaskRun(
  pool: pg.Pool,
  args: {
    runId: string;
    taskId: string;
    chatId: string;
    role: string;
    content: unknown;
    agentId?: string | null;
    model?: string | null;
  },
): Promise<Message | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query(
      `SELECT id FROM messages WHERE id = $1 AND kind = 'task' FOR UPDATE`,
      [args.taskId],
    );
    if (lock.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const inFlight = await client.query(
      `SELECT 1 FROM messages
       WHERE parent_id = $1 AND kind = 'task_run' AND state IN ('pending', 'running')
       LIMIT 1`,
      [args.taskId],
    );
    if ((inFlight.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const ins = await client.query(
      `INSERT INTO messages (
         id, chat_id, role, content, parent_id, kind,
         state, started_at, agent_id, model
       ) VALUES ($1, $2, $3, $4, $5, 'task_run', 'running', now(), $6, $7)
       RETURNING *`,
      [
        args.runId,
        args.chatId,
        args.role,
        JSON.stringify(args.content),
        args.taskId,
        args.agentId ?? null,
        args.model ?? null,
      ],
    );
    await client.query(
      "UPDATE chats SET updated_at = now() WHERE id = $1",
      [args.chatId],
    );
    await client.query("COMMIT");
    return rowToMessage(ins.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Marks a running message as succeeded or failed.
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
 * `schedulerRef: null` clears the column; an object value is stored as JSON.
 * Returns the updated row, or null if not found.
 */
export async function updateMessage(
  db: Queryable,
  id: string,
  patch: {
    content?: unknown;
    state?: string;
    executeAt?: string | null;
    cron?: string | null;
    schedulerRef?: unknown | null;
    title?: string | null;
  },
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
  if (patch.schedulerRef !== undefined) {
    sets.push(`scheduler_ref = $${idx++}`);
    params.push(patch.schedulerRef === null ? null : JSON.stringify(patch.schedulerRef));
  }
  if (patch.title !== undefined) {
    sets.push(`title = $${idx++}`);
    params.push(patch.title);
  }
  params.push(id);
  const { rows } = await db.query(
    `UPDATE messages SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return rows.length ? rowToMessage(rows[0]) : null;
}

/**
 * Returns the most recent agent_id per artifact path for a given workspace.
 * Uses JSONB lateral unnesting to find messages that contain artifactRef
 * content items, then picks the latest agent per path.
 */
export async function findArtifactAuthorsByWorkspace(
  db: Queryable,
  workspaceId: string,
): Promise<Map<string, string>> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (m.content->>'path')
       m.content->>'path' AS path,
       m.agent_id
     FROM messages m
     JOIN chats c ON c.id = m.chat_id
     WHERE c.workspace_id = $1
       AND m.content->>'type' = 'artifactRef'
       AND m.agent_id IS NOT NULL
     ORDER BY m.content->>'path', m.created_at DESC`,
    [workspaceId],
  );
  const result = new Map<string, string>();
  for (const row of rows) {
    if (row.path && row.agent_id) result.set(row.path as string, row.agent_id as string);
  }
  return result;
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

export interface CrossChatListOptions {
  userId: string;
  workspaceId?: string;
  chatId?: string;
  states?: string[];
  scheduled?: boolean;
  awaitingUser?: boolean;
  contentKinds?: string[];
  /** Filter by `messages.kind` (the message-kind discriminator — `task`,
   * `task_run`, `ai_note`, `chat`). Distinct from `contentKinds`, which
   * filters on `content.type`. */
  kinds?: string[];
  /** Filter by `parent_id` — the Tasks page uses this with `kinds=task_run`
   * to fetch a task's run history in one call. */
  parentId?: string;
  since?: string;
  cursor?: string;
  limit?: number;
}

/**
 * Cross-chat message listing — joins messages → chats → workspaces and filters
 * by the caller's ownership so users only ever see their own rows. Ordered
 * `created_at DESC, id DESC` for a stable "newest first" feed usable by the
 * Runs and Today surfaces. Cursor is opaque to callers; format here is
 * `<createdAtISO>|<id>` which lets us seek on the composite (created_at, id)
 * key and break ties deterministically.
 */
export async function listCrossChat(
  db: Queryable,
  opts: CrossChatListOptions,
): Promise<PaginatedMessages> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conditions: string[] = ["w.user_id = $1"];
  const params: unknown[] = [opts.userId];
  let idx = 2;

  if (opts.workspaceId) {
    conditions.push(`c.workspace_id = $${idx++}`);
    params.push(opts.workspaceId);
  }
  if (opts.chatId) {
    conditions.push(`m.chat_id = $${idx++}`);
    params.push(opts.chatId);
  }
  if (opts.states && opts.states.length > 0) {
    const placeholders = opts.states.map(() => `$${idx++}`).join(", ");
    conditions.push(`m.state IN (${placeholders})`);
    params.push(...opts.states);
  }
  if (opts.scheduled === true) {
    conditions.push("(m.execute_at IS NOT NULL OR m.cron IS NOT NULL)");
  } else if (opts.scheduled === false) {
    conditions.push("(m.execute_at IS NULL AND m.cron IS NULL)");
  }
  if (opts.contentKinds && opts.contentKinds.length > 0) {
    const placeholders = opts.contentKinds.map(() => `$${idx++}`).join(", ");
    conditions.push(`(m.content->>'type') IN (${placeholders})`);
    params.push(...opts.contentKinds);
  }
  if (opts.kinds && opts.kinds.length > 0) {
    const placeholders = opts.kinds.map(() => `$${idx++}`).join(", ");
    conditions.push(`m.kind IN (${placeholders})`);
    params.push(...opts.kinds);
  }
  if (opts.parentId) {
    conditions.push(`m.parent_id = $${idx++}`);
    params.push(opts.parentId);
  }
  if (opts.since) {
    conditions.push(`m.created_at > $${idx++}`);
    params.push(new Date(opts.since));
  }
  // `awaitingUser=true`: a message is "awaiting user" when it's the latest row
  // in a chat whose awaiting_user flag is set, authored by the agent in a
  // succeeded state. `false` returns the complement.
  const awaitingClause = `(
    c.awaiting_user = true
    AND m.role = 'agent'
    AND m.state = 'succeeded'
    AND m.id = (
      SELECT m2.id FROM messages m2
      WHERE m2.chat_id = m.chat_id
      ORDER BY m2.created_at DESC, m2.id DESC
      LIMIT 1
    )
  )`;
  if (opts.awaitingUser === true) {
    conditions.push(awaitingClause);
  } else if (opts.awaitingUser === false) {
    conditions.push(`NOT ${awaitingClause}`);
  }
  if (opts.cursor) {
    const sep = opts.cursor.indexOf("|");
    if (sep === -1) {
      throw new Error("Invalid cursor format");
    }
    const cursorIso = opts.cursor.slice(0, sep);
    const cursorId = opts.cursor.slice(sep + 1);
    conditions.push(`(m.created_at, m.id) < ($${idx++}, $${idx++})`);
    params.push(new Date(cursorIso));
    params.push(cursorId);
  }

  const limitIdx = idx;
  params.push(limit + 1);

  const sql = `
    SELECT m.*
    FROM messages m
    JOIN chats c ON c.id = m.chat_id
    JOIN workspaces w ON w.id = c.workspace_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT $${limitIdx}
  `;

  const { rows } = await db.query(sql, params);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(rowToMessage);
  let nextCursor: string | undefined;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = `${last.createdAt}|${last.id}`;
  }
  return { items, nextCursor };
}
