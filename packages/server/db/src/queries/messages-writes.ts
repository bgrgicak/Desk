import { basename } from "node:path/posix";
import { type Pool, transact } from "../pool.js";
import type { Message } from "@agent-desk/shared";
import {
  bumpIsoAbove,
  MAX_REQUEUE_ATTEMPTS,
  newestIso,
  rowToMessage,
} from "./messages-internal.js";

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
 * - `kind='task'` parents stuck in `state='running'`: reset to `pending`.
 *   Agent-authored unscheduled tasks get promoted to `running` on
 *   auto-fire (see api/src/dispatch/sandbox.ts and scheduler/src/runs.ts:
 *   fireMessage). If the previous process died between promote-to-running
 *   and `afterTaskRun`, the parent stays `running` forever and the task
 *   status selector pins the kanban card to Active on every refresh.
 *   Reset to `pending` so cron tasks re-fire on the next tick, one-shot
 *   scheduled tasks re-fire on their existing executeAt, and unscheduled
 *   tasks land in the user-actionable Open column (or Needs input if the
 *   chat is unread) so the user can decide whether to re-run.
 *
 * Returns the IDs of the re-queued chat messages so the caller can fire
 * them immediately rather than waiting for the next scheduler tick.
 */
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
  // Reset task parents stuck in 'running'. Runs above have all been moved
  // to a terminal state, so no child run is in flight; whatever process
  // promoted the parent is gone. 'pending' is the right neutral resting
  // state — scheduled tasks re-fire on their existing executeAt/cron, and
  // unscheduled tasks fall through the status selector to todo / needs_input.
  await db.query(
    `UPDATE messages
     SET state = 'pending',
         started_at = NULL,
         ended_at = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE state = 'running'
       AND kind = 'task'`,
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
  //
  // `unread` means "an agent said something the user hasn't engaged with yet"
  // — your own messages aren't unread to you. Only agent-authored visible
  // messages flip the flag; user messages bump updated_at without flipping
  // unread. This is also the sole signal the Tasks page uses for the
  // "Needs input" bucket (see task-status.ts).
  const contentType = (data.content as { type?: string } | null)?.type;
  const kind = data.kind ?? "chat";
  const isInternal =
    contentType === "agent_turn" ||
    contentType === "summary_request" ||
    contentType === "summary" ||
    contentType === "feedback" ||
    kind === "summary";
  if (!isInternal) {
    const setUnread = data.role === "agent" ? ", unread = 1" : "";
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
      `UPDATE chats SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END${setUnread} WHERE id = ?`,
      [nextUpdatedAt, nextUpdatedAt, data.chatId],
    );
  }
  return rowToMessage(rows[0]);
}

/**
 * Atomically claims a message as the anchor of `threadChatId`. Refuses
 * (returns null) when the message already has a thread — used to enforce
 * the "one thread per message" invariant. Returns the updated row on
 * success.
 */
export async function setThreadChatId(
  db: Pool,
  messageId: string,
  threadChatId: string,
): Promise<Message | null> {
  const { rows } = await db.query(
    `UPDATE messages
     SET thread_chat_id = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND thread_chat_id IS NULL
     RETURNING *`,
    [threadChatId, messageId],
  );
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
 * Marks a running message as succeeded / failed / cancelled.
 *
 * The `WHERE state IN ('pending','running')` guard prevents a stale
 * `failed` finalize from racing past an earlier explicit `cancelled`
 * write: when `preemptChatRun` aborts an in-flight turn, the prior
 * fire's outer-catch in `fireMessage` still runs and would otherwise
 * overwrite `cancelled` back to `failed`. Keep the explicit cancel
 * intent visible to the UI.
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
       AND state IN ('pending', 'running')
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
 * State-guarded partial update. Same patch shape as {@link updateMessage}
 * but only applies when the row's current `state` is in `allowedStates`.
 * Returns the updated row on success, `null` if the guard rejected the
 * write (or the row is missing). Used for "soft" lifecycle transitions
 * that must not clobber an existing terminal state — e.g. promoting an
 * unscheduled task from `pending` to `running` on auto-fire without
 * stomping a concurrent cancel, or mirroring a run's terminal state onto
 * its parent without stomping an explicit `task complete` that already
 * landed.
 */
export async function updateMessageIfState(
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
  allowedStates: readonly string[],
): Promise<Message | null> {
  if (allowedStates.length === 0) return null;
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
  const placeholders = allowedStates.map(() => "?").join(", ");
  for (const s of allowedStates) params.push(s);
  const { rows } = await db.query(
    `UPDATE messages SET ${sets.join(", ")}
     WHERE id = ? AND state IN (${placeholders})
     RETURNING *`,
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
