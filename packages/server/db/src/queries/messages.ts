import { basename } from "node:path/posix";
import { type Pool, transact } from "../pool.js";
import { MessageSchema, type Message } from "@agent-desk/shared";

type MessageListView = "full" | "compact" | "timeline";

function bumpIsoAbove(baseIso: string): string {
  const ms = Date.parse(baseIso);
  if (!Number.isFinite(ms)) return baseIso;
  return new Date(ms + 1).toISOString();
}

function newestIso(values: Array<string | null | undefined>): string | null {
  let newest: string | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) continue;
    if (ms > newestMs) {
      newest = value;
      newestMs = ms;
    }
  }
  return newest;
}

const FULL_MESSAGE_SELECT = `
  id,
  chat_id,
  role,
  content,
  created_at,
  updated_at,
  execute_at,
  cron,
  state,
  parent_id,
  agent_id,
  started_at,
  ended_at,
  model,
  attachments,
  kind,
  title
`;

// Compact chat loads are the normal UI path. Build the compact JSON in SQL so
// hidden tool/event/summary payloads never leave SQLite just to be discarded by
// the API serializer. This keeps the feature surface (visible assistant text,
// agent_turn state, tool-only fallback markers) without shipping megabytes of
// tool inputs/results/log lines on every chat open.
function compactContentSql(column = "content"): string {
  return `
  CASE json_extract(${column}, '$.type')
    WHEN 'events' THEN json_object(
      'type', 'events',
      'log', json(COALESCE((
        SELECT json_group_array(json(
          CASE
            WHEN json_extract(e.value, '$.kind') = 'event' THEN json_object(
              'kind', 'event',
              'event', json_object(
                'type', 'text',
                'part', json_object('text', json_extract(e.value, '$.event.part.text'))
              )
            )
            ELSE json_object('kind', 'unparsed', 'line', json_extract(e.value, '$.line'))
          END
        ))
        FROM json_each(${column}, '$.log') AS e
        WHERE (
          json_extract(e.value, '$.kind') = 'event'
          AND json_extract(e.value, '$.event.type') = 'text'
          AND json_type(e.value, '$.event.part.text') = 'text'
        ) OR (
          json_extract(e.value, '$.kind') = 'unparsed'
          AND NOT EXISTS (
            SELECT 1 FROM json_each(${column}, '$.log') AS e2
            WHERE json_extract(e2.value, '$.kind') = 'event'
              AND CAST(e2.key AS INTEGER) < CAST(e.key AS INTEGER)
          )
        )
      ), '[]'))
    )
    WHEN 'toolCall' THEN json_object(
      'type', 'toolCall',
      'toolName', json_extract(${column}, '$.toolName'),
      'args', json('{}')
    )
    WHEN 'toolResult' THEN json_object(
      'type', 'toolResult',
      'toolName', json_extract(${column}, '$.toolName'),
      'result', NULL
    )
    WHEN 'summary' THEN json_object('type', 'summary', 'body', '')
    ELSE ${column}
  END
`;
}

const COMPACT_MESSAGE_SELECT = FULL_MESSAGE_SELECT.replace("content,", `${compactContentSql()} AS content,`);

const FULL_MESSAGE_SELECT_M = `
  m.id,
  m.chat_id,
  m.role,
  m.content,
  m.created_at,
  m.updated_at,
  m.execute_at,
  m.cron,
  m.state,
  m.parent_id,
  m.agent_id,
  m.started_at,
  m.ended_at,
  m.model,
  m.attachments,
  m.kind,
  m.title
`;

const COMPACT_MESSAGE_SELECT_M = FULL_MESSAGE_SELECT_M.replace("m.content,", `${compactContentSql("m.content")} AS content,`);

function messageSelect(view: MessageListView): string {
  return view === "full" ? FULL_MESSAGE_SELECT : COMPACT_MESSAGE_SELECT;
}

function messageSelectFromAlias(view: MessageListView): string {
  return view === "full" ? FULL_MESSAGE_SELECT_M : COMPACT_MESSAGE_SELECT_M;
}

const CONTENT_TYPE_SQL = "json_extract(content, '$.type')";

// Normal chat rendering does not need summaries or scheduler-only request rows.
// Keep rows that can render in the stream, agent_turn rows that drive
// typing/error state, and compact tool/event marker rows so historical
// tool-only turns can still show the completion fallback without shipping the
// heavy tool inputs/results/logs.
function timelineFilterSql(): { sql: string; params: unknown[] } {
  return {
    sql: `
      AND (
        ${CONTENT_TYPE_SQL} IN ('text', 'artifactRef', 'agent_turn', 'toolCall', 'toolResult', 'events')
      )
    `,
    params: [],
  };
}

async function timelineWhereClause(
  _db: Pool,
  chatId: string,
  view: MessageListView,
): Promise<{ sql: string; params: unknown[] }> {
  void chatId;
  if (view !== "timeline") return { sql: "", params: [] };
  return timelineFilterSql();
}

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

function compactContent(content: Message["content"]): Message["content"] {
  switch (content.type) {
    case "events": {
      const log: typeof content.log = [];
      let sawStructuredEvent = false;
      for (const entry of content.log) {
        if (entry.kind === "event") {
          sawStructuredEvent = true;
          if (entry.event.type === "text") {
            const text = entry.event.part?.text;
            if (typeof text === "string") {
              log.push({
                kind: "event",
                event: { type: "text", part: { text } },
              });
            }
          }
        } else if (entry.kind === "unparsed" && !sawStructuredEvent) {
          log.push(entry);
        }
      }
      return { type: "events", log };
    }
    case "toolCall":
      return { type: "toolCall", toolName: content.toolName, args: {} };
    case "toolResult":
      return { type: "toolResult", toolName: content.toolName, result: null };
    case "summary":
      return { type: "summary", body: "" };
    default:
      return content;
  }
}

function rowToListedMessage(row: Record<string, unknown>, view: MessageListView): Message {
  const message = rowToMessage(row);
  if (view === "full") return message;
  return { ...message, content: compactContent(message.content) };
}

export interface PaginatedMessages {
  items: Message[];
  nextCursor?: string;
  /** Cursor pointing backwards (towards older messages). Present when
   *  `before` was used and there are still older messages. */
  prevCursor?: string;
}

/**
 * Lists messages in a chat with cursor-based pagination.
 *
 * Two pagination directions are supported:
 *
 * - **Forward (default / `cursor`)**: returns messages *after* the cursor
 *   in chronological order. The traditional page-forward behaviour.
 * - **Backward (`before`)**: returns the *newest* `limit` messages whose
 *   `(created_at, id)` is strictly less than the cursor. Items are
 *   returned in chronological (ASC) order so the client can prepend them
 *   without re-sorting. When `before` is omitted and `cursor` is also
 *   omitted, the query returns the **last** `limit` messages (newest
 *   page) so the chat opens at the bottom.
 *
 * Cursor format: `<createdAtISO>|<id>` (unchanged).
 */
export async function listByChat(
  db: Pool,
  chatId: string,
  opts?: { cursor?: string; before?: string; limit?: number; view?: MessageListView },
): Promise<PaginatedMessages> {
  const limit = opts?.limit ?? 50;
  const view = opts?.view ?? "full";

  // Developer-mode (`view=full`) must be a strict superset of regular chat
  // (`view=timeline`) for the same page. A raw "last 50 rows" full query can
  // be smaller from the user's point of view because summaries/request rows
  // consume slots and push ordinary chat messages out of the page. Anchor full
  // pages on the same timeline-visible rows as regular mode, then include every
  // raw row between that oldest visible boundary and the page edge.
  if (view === "full" && opts?.cursor) {
    const sep = opts.cursor.indexOf("|");
    const cursorIso = sep === -1 ? opts.cursor : opts.cursor.slice(0, sep);
    const cursorId = sep === -1 ? "" : opts.cursor.slice(sep + 1);
    const timeline = timelineFilterSql();
    const { rows: boundaryRows } = await db.query<Record<string, unknown>>(
      `SELECT id, created_at
       FROM messages
       WHERE chat_id = ?
         AND (created_at, id) > (?, ?)
         ${timeline.sql}
       ORDER BY created_at, id
       LIMIT ?`,
      [chatId, cursorIso, cursorId, ...timeline.params, limit + 1],
    );

    if (boundaryRows.length > 0) {
      const hasMore = boundaryRows.length > limit;
      const pageTimelineRows = boundaryRows.slice(0, limit);
      const newest = pageTimelineRows[pageTimelineRows.length - 1];

      const { rows } = await db.query(
        `SELECT ${FULL_MESSAGE_SELECT}
         FROM messages
         WHERE chat_id = ?
           AND (created_at, id) > (?, ?)
           AND (created_at, id) <= (?, ?)
         ORDER BY created_at, id`,
        [chatId, cursorIso, cursorId, newest.created_at, newest.id],
      );

      return {
        items: rows.map(rowToMessage),
        nextCursor: hasMore ? `${newest.created_at}|${newest.id}` : undefined,
      };
    }
  }

  if (view === "full" && !opts?.cursor) {
    const beforeSql = opts?.before ? "AND (created_at, id) < (?, ?)" : "";
    const boundaryParams: unknown[] = [chatId];
    if (opts?.before) {
      const sep = opts.before.indexOf("|");
      boundaryParams.push(sep === -1 ? opts.before : opts.before.slice(0, sep));
      boundaryParams.push(sep === -1 ? "" : opts.before.slice(sep + 1));
    }
    boundaryParams.push(limit + 1);

    const timeline = timelineFilterSql();
    const { rows: boundaryRows } = await db.query<Record<string, unknown>>(
      `SELECT id, created_at
       FROM messages
       WHERE chat_id = ? ${beforeSql} ${timeline.sql}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [...boundaryParams.slice(0, boundaryParams.length - 1), ...timeline.params, boundaryParams[boundaryParams.length - 1]],
    );

    if (boundaryRows.length > 0) {
      const hasMore = boundaryRows.length > limit;
      const pageTimelineRows = boundaryRows.slice(0, limit);
      const oldest = pageTimelineRows[pageTimelineRows.length - 1];

      const fullParams: unknown[] = [chatId, oldest.created_at, oldest.id];
      let upperBoundSql = "";
      if (opts?.before) {
        const sep = opts.before.indexOf("|");
        fullParams.push(sep === -1 ? opts.before : opts.before.slice(0, sep));
        fullParams.push(sep === -1 ? "" : opts.before.slice(sep + 1));
        upperBoundSql = "AND (created_at, id) < (?, ?)";
      }

      const { rows } = await db.query(
        `SELECT ${FULL_MESSAGE_SELECT}
         FROM messages
         WHERE chat_id = ?
           AND (created_at, id) >= (?, ?)
           ${upperBoundSql}
         ORDER BY created_at, id`,
        fullParams,
      );

      return {
        items: rows.map(rowToMessage),
        prevCursor: hasMore ? `${oldest.created_at}|${oldest.id}` : undefined,
      };
    }
  }

  const params: unknown[] = [chatId];
  let whereClause = "chat_id = ?";

  // ── Backward pagination (scrollback) ───────────────────────────────
  if (opts?.before) {
    const sep = opts.before.indexOf("|");
    const cursorIso = sep === -1 ? opts.before : opts.before.slice(0, sep);
    const cursorId = sep === -1 ? "" : opts.before.slice(sep + 1);
    whereClause += " AND (created_at, id) < (?, ?)";
    params.push(cursorIso);
    params.push(cursorId);
    const timeline = await timelineWhereClause(db, chatId, view);
    params.push(...timeline.params);
    params.push(limit + 1);

    // Fetch in DESC order so LIMIT clips the *oldest* surplus row, then
    // reverse to ASC for the caller.
    const { rows } = await db.query(
      `SELECT ${messageSelect(view)} FROM messages WHERE ${whereClause} ${timeline.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
      params,
    );

    const hasMore = rows.length > limit;
    // Drop the extra row (oldest) and reverse to chronological order.
    const slice = rows.slice(0, limit).reverse();
    const items = slice.map((row) => rowToListedMessage(row, view));
    let prevCursor: string | undefined;
    if (hasMore && items.length > 0) {
      const oldest = items[0];
      prevCursor = `${oldest.createdAt}|${oldest.id}`;
    }
    return { items, prevCursor };
  }

  // ── Forward pagination / initial load ──────────────────────────────
  if (opts?.cursor) {
    // Traditional forward paging: messages after cursor.
    const sep = opts.cursor.indexOf("|");
    const cursorIso = sep === -1 ? opts.cursor : opts.cursor.slice(0, sep);
    const cursorId = sep === -1 ? "" : opts.cursor.slice(sep + 1);
    whereClause += " AND (created_at, id) > (?, ?)";
    params.push(cursorIso);
    params.push(cursorId);
    const timeline = await timelineWhereClause(db, chatId, view);
    params.push(...timeline.params);
    params.push(limit + 1);

    const { rows } = await db.query(
      `SELECT ${messageSelect(view)} FROM messages WHERE ${whereClause} ${timeline.sql} ORDER BY created_at, id LIMIT ?`,
      params,
    );

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => rowToListedMessage(row, view));
    let nextCursor: string | undefined;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = `${last.createdAt}|${last.id}`;
    }
    return { items, nextCursor };
  }

  // No cursor at all → return the *last* `limit` messages (newest page)
  // so the chat opens at the bottom. Include a prevCursor when there are
  // older messages.
  const timeline = await timelineWhereClause(db, chatId, view);
  params.push(...timeline.params);
  params.push(limit + 1);
  const { rows } = await db.query(
    `SELECT ${messageSelect(view)} FROM messages WHERE ${whereClause} ${timeline.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
    params,
  );

  const hasMore = rows.length > limit;
  const slice = rows.slice(0, limit).reverse();
  const items = slice.map((row) => rowToListedMessage(row, view));
  let prevCursor: string | undefined;
  if (hasMore && items.length > 0) {
    const oldest = items[0];
    prevCursor = `${oldest.createdAt}|${oldest.id}`;
  }
  return { items, prevCursor };
}

/**
 * Returns all messages in a chat that the agent should see as context,
 * starting from the most recent summary (inclusive) so context is bounded
 * by the last compaction point.
 */
export async function listAgentContextByChat(
  db: Pool,
  chatId: string,
): Promise<Message[]> {
  const { rows } = await db.query(
    `WITH latest_summary AS (
       SELECT created_at, id FROM messages
       WHERE chat_id = ?
         AND json_extract(content, '$.type') = 'summary'
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     )
     SELECT m.* FROM messages m
      WHERE m.chat_id = ?
        AND m.kind NOT IN ('task', 'task_run')
        AND NOT EXISTS (
          SELECT 1 FROM messages parent
          WHERE parent.id = m.parent_id AND parent.kind = 'task_run'
        )
        AND (
          NOT EXISTS (SELECT 1 FROM latest_summary)
          OR m.created_at > (SELECT created_at FROM latest_summary)
          OR (
            m.created_at = (SELECT created_at FROM latest_summary)
            AND m.id >= (SELECT id FROM latest_summary)
          )
        )
       ORDER BY m.created_at, m.id
    `,
    [chatId, chatId],
  );
  return rows.map(rowToMessage);
}

/**
 * Recovers orphaned runs on server startup.
 *
 * An orphan is a message stuck in `running` or `pending` (non-scheduled)
 * state from a previous server process that died before finalising it.
 *
 * - `agent_turn` / `summary_request` (chat messages): reset to `pending`
 *   with `execute_at = now` so the scheduler re-fires them immediately.
 *   These were interrupted by a crash/restart — not by an agent error —
 *   so retrying is the right behaviour.
 *
 * - `task_run`: mark as `failed`. The parent task re-schedules via cron;
 *   one-shot tasks need manual retry.
 *
 * Returns the IDs of the re-queued chat messages so the caller can fire
 * them immediately rather than waiting for the next scheduler tick.
 */
const MAX_REQUEUE_ATTEMPTS = 5;

export async function recoverOrphanedRuns(db: Pool): Promise<{ requeued: string[]; failed: number }> {
  // Fail orphans that have already hit the retry cap before re-queuing the
  // rest. Running the fail query first ensures a message that reaches
  // requeue_count = MAX_REQUEUE_ATTEMPTS gets one final attempt (from the
  // previous cycle) before being marked failed — rather than being failed on
  // the same call that would have re-queued it.
  const { rowCount: cappedCount } = await db.query(
    `UPDATE messages
     SET state = 'failed',
         ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE state IN ('running', 'pending')
       AND json_extract(content, '$.type') IN ('agent_turn', 'summary_request')
       AND (execute_at IS NULL OR execute_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       AND requeue_count >= ?`,
    [MAX_REQUEUE_ATTEMPTS],
  );
  // Re-queue remaining orphans that haven't exceeded the cap yet.
  const { rows: requeuedRows } = await db.query<{ id: string }>(
    `UPDATE messages
     SET state = 'pending',
         started_at = NULL,
         ended_at = NULL,
         execute_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         requeue_count = requeue_count + 1
     WHERE state IN ('running', 'pending')
       AND json_extract(content, '$.type') IN ('agent_turn', 'summary_request')
       AND (execute_at IS NULL OR execute_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       AND requeue_count < ?
      RETURNING id`,
    [MAX_REQUEUE_ATTEMPTS],
  );
  // Fail task_run orphans — their parent task handles rescheduling.
  const { rowCount: failedCount } = await db.query(
    `UPDATE messages
     SET state = 'failed',
         ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE state IN ('running', 'pending')
       AND kind = 'task_run'
       AND (execute_at IS NULL OR execute_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    [],
  );
  return {
    requeued: requeuedRows.map((r) => r.id),
    failed: (cappedCount ?? 0) + (failedCount ?? 0),
  };
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
  // Internal messages (summaries, summary requests, agent_turn triggers)
  // are not ordinary user/agent chat activity and should not flip unread or bump
  // updated_at — either change would create noise in the sidebar (unread
  // dot, reordering). Dev-mode users can see some of these but should get
  // the same treatment: no false unread signals.
  //
  // The check uses both content.type (the message payload discriminator)
  // AND kind (the message-kind discriminator). Summary output children
  // (including failed-run error output) carry kind="summary" so they're
  // internal regardless of content.type. Artifact references are intentionally
  // not treated as internal: they are visible agent messages and should move the
  // chat to the top just like text output.
  const contentType = (data.content as { type?: string } | null)?.type;
  const kind = data.kind ?? "chat";
  const isInternal =
    contentType === "agent_turn" ||
    contentType === "summary_request" ||
    contentType === "summary" ||
    kind === "summary";
  if (!isInternal) {
    const { rows: activityRows } = await db.query<{
      current_updated_at: string | null;
      max_updated_at: string | null;
      max_count: number | null;
    }>(
      `WITH current_chat AS (
         SELECT workspace_id, updated_at
         FROM chats
         WHERE id = ?
       ), workspace_max AS (
         SELECT MAX(updated_at) AS max_updated_at
         FROM chats
         WHERE workspace_id = (SELECT workspace_id FROM current_chat)
       )
       SELECT
         current_chat.updated_at AS current_updated_at,
         workspace_max.max_updated_at AS max_updated_at,
         (
           SELECT COUNT(*)
           FROM chats
           WHERE workspace_id = current_chat.workspace_id
             AND updated_at = workspace_max.max_updated_at
         ) AS max_count
       FROM current_chat, workspace_max`,
      [data.chatId],
    );
    const activity = activityRows[0];
    const currentUpdatedAt = activity?.current_updated_at ?? null;
    const maxUpdatedAt = activity?.max_updated_at ?? null;
    const messageCreatedAt = rows[0].created_at as string;
    const currentMs = currentUpdatedAt ? Date.parse(currentUpdatedAt) : Number.NEGATIVE_INFINITY;
    const maxMs = maxUpdatedAt ? Date.parse(maxUpdatedAt) : Number.NEGATIVE_INFINITY;
    const messageMs = Date.parse(messageCreatedAt);
    const isSoleNewest = (activity?.max_count ?? 0) <= 1;
    const nextUpdatedAt =
      isSoleNewest && Number.isFinite(currentMs) && currentMs >= maxMs && currentMs >= messageMs
        ? currentUpdatedAt
        : newestIso([messageCreatedAt, maxUpdatedAt ? bumpIsoAbove(maxUpdatedAt) : null]) ?? messageCreatedAt;

    await db.query(
      "UPDATE chats SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END, unread = 1 WHERE id = ?",
      [nextUpdatedAt, nextUpdatedAt, data.chatId],
    );
  }
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
 * This intentionally does not mutate the parent task status. The run row owns
 * agent execution state; explicit user actions that move a plain task to
 * Active update the parent before calling the scheduler, while automatic or
 * scheduled fires remain visible through their task_run child.
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
    kind?: string;
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
  if (patch.kind !== undefined) {
    sets.push(`kind = ?`);
    params.push(patch.kind);
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
   * `task_run`, `summary`, `chat`). Distinct from `contentKinds`, which
   * filters on `content.type`. */
  kinds?: string[];
  /** Filter by `parent_id` — the Tasks page uses this with `kinds=task_run`
   * to fetch a task's run history in one call. */
  parentId?: string;
  since?: string;
  cursor?: string;
  limit?: number;
  view?: MessageListView;
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
  // `awaitingUser=true`: a message is "awaiting user" when it's the latest
  // user-visible row in a chat whose awaiting_user flag is set, authored by the
  // agent in a succeeded state. Internal rows such as chat summaries are
  // ignored for this latest-message check so background compaction does not
  // create or clear user-facing new-message badges.
  // SQLite stores BOOLEAN as INTEGER 0/1.
  const nonInternalClause = `(NOT (
    (json_valid(m.content) AND json_extract(m.content, '$.type') IN ('agent_turn', 'summary_request', 'summary', 'artifactRef'))
    OR m.kind = 'summary'
  ))`;
  const nonInternalLatestClause = `(NOT (
    (json_valid(m2.content) AND json_extract(m2.content, '$.type') IN ('agent_turn', 'summary_request', 'summary', 'artifactRef'))
    OR m2.kind = 'summary'
  ))`;
  const awaitingClause = `(
    c.awaiting_user = 1
    AND ${nonInternalClause}
    AND m.role = 'agent'
    AND m.state = 'succeeded'
    AND m.id = (
      SELECT m2.id FROM messages m2
      WHERE m2.chat_id = m.chat_id
        AND ${nonInternalLatestClause}
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
    SELECT ${messageSelectFromAlias(opts.view ?? "full")}
    FROM messages m
    JOIN chats c ON c.id = m.chat_id
    JOIN workspaces w ON w.id = c.workspace_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `;

  const { rows } = await db.query(sql, params);
  const hasMore = rows.length > limit;
  const view = opts.view ?? "full";
  const items = rows.slice(0, limit).map((row) => rowToListedMessage(row, view));
  let nextCursor: string | undefined;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = `${last.createdAt}|${last.id}`;
  }
  return { items, nextCursor };
}
