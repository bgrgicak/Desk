import { basename } from "node:path/posix";
import { type Pool, transact } from "../pool.js";
import { MessageSchema, type Message } from "@agent-desk/shared";

// SQLite stores JSON columns as TEXT; parse at the boundary. Postgres
// JSONB used to do this for us automatically.
function parseJson<T>(v: unknown): T | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return JSON.parse(v) as T;
  return v as T;
}

function rowToMessage(row: Record<string, unknown>): Message {
  return MessageSchema.parse({
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    content: parseJson(row.content),
    createdAt: row.created_at as string,
    attachments: parseJson(row.attachments),
    model: row.model ?? undefined,
    executeAt: row.execute_at ? row.execute_at as string : undefined,
    cron: row.cron ?? undefined,
    state: row.state ?? undefined,
    parentId: row.parent_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    startedAt: row.started_at ? row.started_at as string : undefined,
    endedAt: row.ended_at ? row.ended_at as string : undefined,
    updatedAt: row.updated_at ? row.updated_at as string : undefined,
    kind: row.kind ?? "chat",
    title: row.title ?? null,
  });
}

export interface PaginatedMessages {
  items: Message[];
  nextCursor?: string;
}

export async function listByChat(
  db: Pool,
  chatId: string,
  opts?: { cursor?: string; limit?: number },
): Promise<PaginatedMessages> {
  const limit = opts?.limit ?? 50;
  // Cursor is `<createdAtISO>|<id>` so paging stays stable when multiple
  // messages share a ms-precision timestamp — without the id tiebreaker,
  // `created_at > cursor` would skip every message that landed in the
  // same tick as the cursor row.
  // SQL uses anonymous `?` placeholders bound by textual order. The
  // params array is built to match: chatId, [cursorIso, cursorId,] limit.
  const params: unknown[] = [chatId];
  let whereClause = "chat_id = ?";

  if (opts?.cursor) {
    const sep = opts.cursor.indexOf("|");
    const cursorIso = sep === -1 ? opts.cursor : opts.cursor.slice(0, sep);
    const cursorId = sep === -1 ? "" : opts.cursor.slice(sep + 1);
    whereClause += " AND (created_at, id) > (?, ?)";
    params.push(cursorIso);
    params.push(cursorId);
  }
  params.push(limit + 1);

  const { rows } = await db.query(
    `SELECT * FROM messages WHERE ${whereClause} ORDER BY created_at, id LIMIT ?`,
    params,
  );

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(rowToMessage);
  let nextCursor: string | undefined;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = `${last.createdAt}|${last.id}`;
  }
  return { items, nextCursor };
}

export async function insert(
  db: Pool,
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
    attachments?: unknown;
    model?: string | null;
    kind?: string | null;
    title?: string | null;
  },
): Promise<Message> {
  const { rows } = await db.query(
    `INSERT INTO messages (
       id, chat_id, role, content,
       state, execute_at, cron, parent_id, agent_id,
       attachments, model, kind, title
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
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
      data.attachments ? JSON.stringify(data.attachments) : null,
      data.model ?? null,
      data.kind ?? "chat",
      data.title ?? null,
    ],
  );
  // Touch the parent chat's updated_at
  await db.query(
    "UPDATE chats SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), unread = 1 WHERE id = ?",
    [data.chatId],
  );
  return rowToMessage(rows[0]);
}

export async function findById(db: Pool, id: string): Promise<Message | null> {
  const { rows } = await db.query("SELECT * FROM messages WHERE id = ?", [id]);
  return rows.length ? rowToMessage(rows[0]) : null;
}

/**
 * Transitions a message from pending → running atomically. Returns true if
 * the message was picked up (we own it), false if it was already running,
 * terminal, or missing. This is the central idempotence point for the
 * fire handler: concurrent attempts to fire the same message converge
 * on one execution.
 */
export async function claimPending(db: Pool, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE messages
     SET state = 'running',
         started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND state = 'pending'`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Atomically starts a new task_run row as a child of the task message.
 * Refuses if another task_run for the same task is already pending or
 * running (so concurrent fires of the same task converge on one in-flight
 * run), and inserts the new row directly in `running` state with
 * `started_at = strftime(... 'now')`. Returns the run row, or null if the task is
 * missing / not a task / already firing.
 *
 * Concurrency model: the body runs inside a synchronous `transact`
 * (BEGIN IMMEDIATE). better-sqlite3's transaction wrapper + SQLite's
 * file lock serialize the entire callback, so the existence check and
 * the INSERT can't interleave with another fire on the same task. The
 * loser of the race sees the winner's committed task_run via the
 * in-flight check and returns null — no SQL-level row lock involved.
 */
export async function startTaskRun(
  pool: Pool,
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
  return transact(pool, (client): Message | null => {
    const lock = client.querySync(
      `SELECT id FROM messages WHERE id = ? AND kind = 'task'`,
      [args.taskId],
    );
    if (lock.rowCount === 0) return null;
    const inFlight = client.querySync(
      `SELECT 1 FROM messages
       WHERE parent_id = ? AND kind = 'task_run' AND state IN ('pending', 'running')
       LIMIT 1`,
      [args.taskId],
    );
    if ((inFlight.rowCount ?? 0) > 0) return null;
    const ins = client.querySync(
      `INSERT INTO messages (
         id, chat_id, role, content, parent_id, kind,
         state, started_at, agent_id, model
       ) VALUES (?, ?, ?, ?, ?, 'task_run', 'running', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)
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
    // Mark the parent task as running so the kanban moves the card to Active.
    client.querySync(
      `UPDATE messages SET state = 'running',
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND kind = 'task'`,
      [args.taskId],
    );
    client.querySync(
      "UPDATE chats SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      [args.chatId],
    );
    return rowToMessage(ins.rows[0]);
  });
}

/**
 * Marks a running message as succeeded or failed.
 */
export async function finalizeExecution(
  db: Pool,
  id: string,
  terminalState: "succeeded" | "failed" | "cancelled",
): Promise<Message | null> {
  const { rows } = await db.query(
    `UPDATE messages
     SET state = ?,
         ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?
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
  db: Pool,
  id: string,
  patch: {
    content?: unknown;
    state?: string;
    executeAt?: string | null;
    cron?: string | null;
    title?: string | null;
  },
): Promise<Message | null> {
  const sets: string[] = ["updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"];
  const params: unknown[] = [];
  if (patch.content !== undefined) {
    sets.push(`content = ?`);
    params.push(JSON.stringify(patch.content));
  }
  if (patch.state !== undefined) {
    sets.push(`state = ?`);
    params.push(patch.state);
  }
  if (patch.executeAt !== undefined) {
    sets.push(`execute_at = ?`);
    params.push(patch.executeAt === null ? null : new Date(patch.executeAt));
  }
  if (patch.cron !== undefined) {
    sets.push(`cron = ?`);
    params.push(patch.cron);
  }
  if (patch.title !== undefined) {
    sets.push(`title = ?`);
    params.push(patch.title);
  }
  params.push(id);
  const { rows } = await db.query(
    `UPDATE messages SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  return rows.length ? rowToMessage(rows[0]) : null;
}

/**
 * Rewrites `attachments[].path` on every message in `workspaceId` whose
 * attachment refs point at a renamed library entry. Both the exact path
 * (`path === fromPath`) and any descendant (`path` starts with
 * `fromPath + "/"`) are rewritten — covers file rename (only exact
 * match applies in practice) and folder rename (both apply: the folder
 * itself plus everything under it).
 *
 * Returns the updated rows so the caller can broadcast `message.updated`
 * events; clients then patch their per-chat message cache without a
 * full refetch.
 */
export async function retargetAttachmentPaths(
  db: Pool,
  workspaceId: string,
  fromPath: string,
  toPath: string,
): Promise<Message[]> {
  const fromWithSlash = fromPath + "/";
  // Pull every candidate row with non-null attachments in this workspace
  // and parse JSON in JS — SQLite JSON1 can rewrite a single field but
  // the array iteration + per-element prefix logic is clearer here, and
  // a workspace's message volume is small enough that the extra parse
  // doesn't matter.
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT m.id, m.attachments
     FROM messages m
     JOIN chats c ON c.id = m.chat_id
     WHERE c.workspace_id = ? AND m.attachments IS NOT NULL`,
    [workspaceId],
  );

  const updated: Message[] = [];
  for (const row of rows) {
    const raw = row.attachments;
    if (typeof raw !== "string" || raw === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    let changed = false;
    const next = parsed.map((att) => {
      const p = (att as { path?: unknown })?.path;
      if (typeof p !== "string") return att;
      // Rewrite the displayed `name` alongside the path: chat attachments
      // are sent with `name = basename(path)` (see buildSendMessageBodyFromForm
      // and addStagedFromLibrary), and the message-bubble chip shows it as
      // the primary title. Leaving it stale produces the "Hello.txt" /
      // "Hello3.txt" split visible in the UI after a rename.
      if (p === fromPath) {
        changed = true;
        return {
          ...(att as Record<string, unknown>),
          path: toPath,
          name: basename(toPath),
        };
      }
      if (p.startsWith(fromWithSlash)) {
        changed = true;
        // Folder rename: the descendant's basename is unchanged, so
        // basename(newPath) === existing name. Recompute uniformly to
        // keep the rule simple.
        const newPath = toPath + p.slice(fromPath.length);
        return {
          ...(att as Record<string, unknown>),
          path: newPath,
          name: basename(newPath),
        };
      }
      return att;
    });
    if (!changed) continue;
    const result = await db.query(
      `UPDATE messages
       SET attachments = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?
       RETURNING *`,
      [JSON.stringify(next), row.id as string],
    );
    if (result.rows.length > 0) {
      updated.push(rowToMessage(result.rows[0] as Record<string, unknown>));
    }
  }
  return updated;
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
  db: Pool,
  opts: CrossChatListOptions,
): Promise<PaginatedMessages> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // SQL is built with anonymous `?` placeholders. Each branch pushes its
  // params in textual order to match the order the placeholders appear
  // in the assembled WHERE clause; the LIMIT param is appended last.
  const conditions: string[] = ["w.user_id = ?"];
  const params: unknown[] = [opts.userId];

  if (opts.workspaceId) {
    conditions.push(`c.workspace_id = ?`);
    params.push(opts.workspaceId);
  }
  if (opts.chatId) {
    conditions.push(`m.chat_id = ?`);
    params.push(opts.chatId);
  }
  if (opts.states && opts.states.length > 0) {
    const placeholders = opts.states.map(() => `?`).join(", ");
    conditions.push(`m.state IN (${placeholders})`);
    params.push(...opts.states);
  }
  if (opts.scheduled === true) {
    conditions.push("(m.execute_at IS NOT NULL OR m.cron IS NOT NULL)");
  } else if (opts.scheduled === false) {
    conditions.push("(m.execute_at IS NULL AND m.cron IS NULL)");
  }
  if (opts.contentKinds && opts.contentKinds.length > 0) {
    const placeholders = opts.contentKinds.map(() => `?`).join(", ");
    conditions.push(`json_extract(m.content, '$.type') IN (${placeholders})`);
    params.push(...opts.contentKinds);
  }
  if (opts.kinds && opts.kinds.length > 0) {
    const placeholders = opts.kinds.map(() => `?`).join(", ");
    conditions.push(`m.kind IN (${placeholders})`);
    params.push(...opts.kinds);
  }
  if (opts.parentId) {
    conditions.push(`m.parent_id = ?`);
    params.push(opts.parentId);
  }
  if (opts.since) {
    conditions.push(`m.created_at > ?`);
    params.push(new Date(opts.since));
  }
  // `awaitingUser=true`: a message is "awaiting user" when it's the latest row
  // in a chat whose awaiting_user flag is set, authored by the agent in a
  // succeeded state. `false` returns the complement.
  // SQLite stores BOOLEAN as INTEGER 0/1.
  const awaitingClause = `(
    c.awaiting_user = 1
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
    conditions.push(`(m.created_at, m.id) < (?, ?)`);
    params.push(new Date(cursorIso));
    params.push(cursorId);
  }

  params.push(limit + 1);

  const sql = `
    SELECT m.*
    FROM messages m
    JOIN chats c ON c.id = m.chat_id
    JOIN workspaces w ON w.id = c.workspace_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
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
