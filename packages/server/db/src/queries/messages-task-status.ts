import {
  computeTaskStatus,
  type Message,
} from "@agent-desk/shared";
import type { Pool } from "../pool.js";
import { rowToMessage } from "./messages-internal.js";

/**
 * Server-side decorator that stamps `taskStatus` on every `kind:'task'`
 * row before it leaves the API (REST responses and WS broadcasts).
 *
 * This is the single place the status is computed. Surfaces in the SPA
 * read `message.taskStatus` directly — they no longer join chats and
 * task_runs in JS to derive it, which is what previously let badges
 * disagree across the Tasks page, the inline task card, the chat right
 * panel, and Home.
 *
 * The chat lookup uses `threadChatId ?? chatId` because a sub-task's
 * agent runs in its dedicated thread chat — that's where `unread` and
 * the live agent_turn fire, not on the anchor's parent chat.
 */
export async function decorateMessagesWithTaskStatus(
  db: Pool,
  messages: ReadonlyArray<Message>,
): Promise<Message[]> {
  if (messages.length === 0) return [];
  const taskMessages = messages.filter((m) => m.kind === "task");
  if (taskMessages.length === 0) return messages.slice();

  const hostChatIds = Array.from(
    new Set(taskMessages.map((m) => m.threadChatId ?? m.chatId)),
  );

  // Per-chat (unread, running) lookup. `running` mirrors the same SQL
  // fragment chats.ts uses to expose `running` on the chats list —
  // "latest agent_turn is pending or running". We can't import it
  // because chats.ts keeps it module-private, so the literal is
  // duplicated here. If this drifts the fix is to lift it into a
  // shared SQL helper.
  const chatPlaceholders = hostChatIds.map(() => "?").join(", ");
  type ChatSignalRow = { id: string; unread: number; is_running: number };
  const { rows: chatRows } = await db.query(
    `SELECT
       c.id AS id,
       c.unread AS unread,
       COALESCE((
         SELECT m.state IN ('pending', 'running')
         FROM messages m
         WHERE m.chat_id = c.id
           AND json_valid(m.content)
           AND json_extract(m.content, '$.type') = 'agent_turn'
         ORDER BY m.created_at DESC, m.rowid DESC
         LIMIT 1
       ), 0) AS is_running
     FROM chats c
     WHERE c.id IN (${chatPlaceholders})`,
    hostChatIds,
  );
  const chatSignals = new Map<string, { unread: boolean; running: boolean }>();
  for (const row of chatRows as ChatSignalRow[]) {
    chatSignals.set(row.id, {
      unread: !!row.unread,
      running: !!row.is_running,
    });
  }

  // Any child task_run currently running flips the parent task to
  // Active even when the parent row itself is still 'pending'.
  const taskIds = taskMessages.map((m) => m.id);
  const taskPlaceholders = taskIds.map(() => "?").join(", ");
  type RunRow = { parent_id: string };
  const { rows: runRows } = await db.query(
    `SELECT DISTINCT parent_id
     FROM messages
     WHERE kind = 'task_run'
       AND state = 'running'
       AND parent_id IN (${taskPlaceholders})`,
    taskIds,
  );
  const tasksWithRunningRun = new Set<string>();
  for (const row of runRows as RunRow[]) {
    tasksWithRunningRun.add(row.parent_id);
  }

  return messages.map((m) => {
    if (m.kind !== "task") return m;
    const chat = chatSignals.get(m.threadChatId ?? m.chatId);
    const taskStatus = computeTaskStatus({
      state: m.state,
      executeAt: m.executeAt,
      cron: m.cron,
      runStates: tasksWithRunningRun.has(m.id) ? ["running"] : [],
      chat,
    });
    return { ...m, taskStatus };
  });
}

/**
 * Single-message variant for hot WS broadcast paths where the caller
 * has just inserted or updated one row. Falls back to leaving the
 * message untouched on the non-task path so existing emit sites can
 * call this unconditionally.
 */
export async function decorateMessageWithTaskStatus(
  db: Pool,
  message: Message,
): Promise<Message> {
  if (message.kind !== "task") return message;
  const decorated = await decorateMessagesWithTaskStatus(db, [message]);
  return decorated[0] ?? message;
}

/**
 * Returns every task message whose computed `taskStatus` may have
 * changed because of activity on the given chat — used by the WS
 * cascade so the SPA can repaint badges live without re-deriving
 * status itself.
 *
 * A task is affected if the chat is either its anchor chat (`chat_id`)
 * or its dedicated thread chat (`thread_chat_id`). Already-terminated
 * tasks (state in succeeded/cancelled) can't transition again, so we
 * skip them to keep the broadcast tight.
 */
export async function findTasksAffectedByChat(
  db: Pool,
  chatId: string,
): Promise<Message[]> {
  const { rows } = await db.query(
    `SELECT
       id, chat_id, role, content, created_at, updated_at, execute_at,
       cron, state, parent_id, agent_id, started_at, ended_at, model,
       attachments, kind, title, thread_chat_id
     FROM messages
     WHERE kind = 'task'
       AND (chat_id = ? OR thread_chat_id = ?)
       AND (state IS NULL OR state NOT IN ('succeeded', 'cancelled'))`,
    [chatId, chatId],
  );
  if (rows.length === 0) return [];
  const messages = rows.map((r) => rowToMessage(r));
  return decorateMessagesWithTaskStatus(db, messages);
}
