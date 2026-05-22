import type { Pool } from "../pool.js";
import type { Message, TaskStatus } from "@agent-desk/shared";
import {
  FULL_MESSAGE_SELECT,
  FULL_MESSAGE_SELECT_M,
  rowToListedMessage,
  rowToMessage,
  timelineFilterSql,
  timelineWhereClause,
  type MessageListView,
  type PaginatedMessages,
} from "./messages-internal.js";
import { decorateMessagesWithTaskStatus } from "./messages-task-status.js";

/**
 * Wraps a paginated result with `taskStatus` decoration so every
 * Message that leaves the read layer carries the canonical, computed
 * task status. Surfaces no longer need to join chats + task_runs in JS
 * to derive it — that drift was the root cause of badges disagreeing
 * across the Tasks page, the inline TaskResultCard, ChatRightPanel,
 * and Home.
 */
async function decoratePaginated(
  db: Pool,
  result: PaginatedMessages,
): Promise<PaginatedMessages> {
  result.items = await decorateMessagesWithTaskStatus(db, result.items);
  return result;
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
  const result = await listByChatInChat(db, chatId, opts);
  // Mount the parent message at the top of a thread chat. Only on the
  // chronologically-earliest page: forward pagination (`cursor`) skips
  // the start of the transcript, and backward pagination only reaches
  // the start when `prevCursor` is undefined.
  if (!opts?.cursor && result.prevCursor === undefined) {
    const anchor = await findAnchorForThreadChat(db, chatId, opts?.view ?? "full");
    if (anchor) {
      result.items = [anchor, ...result.items];
    }
  }
  return decoratePaginated(db, result);
}

async function listByChatInChat(
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
      `SELECT ${FULL_MESSAGE_SELECT} FROM messages WHERE ${whereClause} ${timeline.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
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
      `SELECT ${FULL_MESSAGE_SELECT} FROM messages WHERE ${whereClause} ${timeline.sql} ORDER BY created_at, id LIMIT ?`,
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
    `SELECT ${FULL_MESSAGE_SELECT} FROM messages WHERE ${whereClause} ${timeline.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
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
  const items = rows.map(rowToMessage);

  // Mount the parent message of a thread chat as the first item. The
  // anchor lives in the parent chat, so the SQL query never returns it.
  // Prepend it here so the agent's context begins with the message the
  // thread was opened from.
  const anchor = await findAnchorForThreadChat(db, chatId);
  if (anchor) {
    return [anchor, ...items];
  }
  return items;
}

export async function findById(db: Pool, id: string): Promise<Message | null> {
  const { rows } = await db.query("SELECT * FROM messages WHERE id = ?", [id]);
  if (!rows.length) return null;
  const message = rowToMessage(rows[0]);
  const [decorated] = await decorateMessagesWithTaskStatus(db, [message]);
  return decorated;
}

/**
 * Returns the anchor (parent) message of the given thread chat, or null
 * if the chat is not a thread or its anchor was deleted. The anchor lives
 * in the parent chat; `thread_chat_id = chat.id` is the link.
 *
 * Pass `view` to apply the same compact content stripping used by
 * `listByChat` — omit (or pass "full") when the caller needs raw content
 * (e.g. agent context, scheduler prompt).
 */
export async function findAnchorForThreadChat(
  db: Pool,
  threadChatId: string,
  view: MessageListView = "full",
): Promise<Message | null> {
  const { rows } = await db.query(
    `SELECT ${FULL_MESSAGE_SELECT} FROM messages WHERE thread_chat_id = ? LIMIT 1`,
    [threadChatId],
  );
  if (!rows.length) return null;
  return view === "full" ? rowToMessage(rows[0]) : rowToListedMessage(rows[0], view);
}

export interface CrossChatListOptions {
  userId: string;
  workspaceId?: string;
  chatId?: string;
  states?: string[];
  scheduled?: boolean;
  unread?: boolean;
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
  /** Filter by the *computed* `taskStatus` (`needs_input`, `active`,
   * `scheduled`, `complete`, `todo`, `failed`). OR semantics: a row passes
   * if its decorated status is in the list. Applied after
   * `decorateMessagesWithTaskStatus`, so callers get the same answer as
   * reading `m.taskStatus` themselves — but server-side, which is what
   * Home's per-bucket queries want. Pagination is best-effort when this
   * is set (we fetch a wider window before filtering); callers that need
   * exact paging should stick to the raw `states` filter. */
  taskStatuses?: TaskStatus[];
}

/**
 * SQL row cap applied before the taskStatus post-filter runs. Has to be
 * large enough that "all tasks in a user's workspace" fits comfortably —
 * the alternative is computing taskStatus inline in SQL, which would
 * duplicate `computeTaskStatus` priority logic in two places. For Home,
 * the realistic upper bound is dozens of tasks per workspace.
 */
const TASK_STATUS_FILTER_FETCH_CAP = 1000;

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
  // When the caller filters by computed `taskStatus`, raw-state pagination
  // is no longer the right page boundary — a 50-row page might decorate
  // down to 0 matches and look "done" while plenty of rows behind the
  // cursor still qualify. Widen the SQL fetch so the post-filter sees the
  // whole working set; if a workspace ever bumps the cap, the symptom is
  // a missing tail rather than a wrong page count.
  const filterByTaskStatus = (opts.taskStatuses ?? []).length > 0;
  const sqlLimit = filterByTaskStatus ? TASK_STATUS_FILTER_FETCH_CAP : limit;
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
  // `unread=true`: a message is "unread" when it's the latest user-visible
  // row in a chat whose `unread` flag is set, authored by the agent in a
  // succeeded state. With the tightened unread semantics (only agent
  // messages flip the chat flag — see messages-writes.ts), the role check
  // is technically redundant but kept as a belt-and-braces guard against
  // any legacy rows. Internal rows such as chat summaries are ignored for
  // the latest-message check so background compaction does not create or
  // clear user-facing badges. Artifact references are intentionally NOT
  // treated as internal: they are visible agent output (the user sees a
  // card for the new artifact) and a chat whose latest agent message is
  // an artifactRef should still surface as unread — matching the writes
  // side, which flips chat.unread on artifactRef inserts.
  // SQLite stores BOOLEAN as INTEGER 0/1.
  const nonInternalClause = `(NOT (
    (json_valid(m.content) AND json_extract(m.content, '$.type') IN ('agent_turn', 'summary_request', 'summary'))
    OR m.kind = 'summary'
  ))`;
  const nonInternalLatestClause = `(NOT (
    (json_valid(m2.content) AND json_extract(m2.content, '$.type') IN ('agent_turn', 'summary_request', 'summary'))
    OR m2.kind = 'summary'
  ))`;
  const unreadClause = `(
    c.unread = 1
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
  if (opts.unread === true) {
    conditions.push(unreadClause);
  } else if (opts.unread === false) {
    conditions.push(`NOT ${unreadClause}`);
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

  params.push(sqlLimit + 1);

  const sql = `
    SELECT ${FULL_MESSAGE_SELECT_M}
    FROM messages m
    JOIN chats c ON c.id = m.chat_id
    JOIN workspaces w ON w.id = c.workspace_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `;

  const { rows } = await db.query(sql, params);
  const view = opts.view ?? "full";

  if (filterByTaskStatus) {
    // Decorate the whole working set, filter on the computed status, and
    // page over the survivors. `hasMore` here means "another decorated
    // match exists past the page", which is the user-facing meaning the
    // filter expects.
    const decoratedAll = await decorateMessagesWithTaskStatus(
      db,
      rows.map((row) => rowToListedMessage(row, view)),
    );
    const allowed = new Set(opts.taskStatuses);
    const matching = decoratedAll.filter(
      (m) => m.taskStatus !== undefined && allowed.has(m.taskStatus),
    );
    const pageItems = matching.slice(0, limit);
    const hasMore = matching.length > limit;
    let nextCursor: string | undefined;
    if (hasMore && pageItems.length > 0) {
      const last = pageItems[pageItems.length - 1];
      nextCursor = `${last.createdAt}|${last.id}`;
    }
    return { items: pageItems, nextCursor };
  }

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => rowToListedMessage(row, view));
  let nextCursor: string | undefined;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = `${last.createdAt}|${last.id}`;
  }
  return decoratePaginated(db, { items, nextCursor });
}
