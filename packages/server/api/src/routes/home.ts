import { type Pool, queries } from "@roomy-ai/db";
import {
  messageTextPreview,
  type ChatWithListMeta,
  type Message,
  type Workspace,
} from "@roomy-ai/shared";

const DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DONE_LIMIT = 20;
const TASK_BUCKET_LIMIT = 200;

export type HomeDayItemStatus =
  | "needs_input"
  | "active"
  | "done";

interface HomeDayBaseItem {
  id: string;
  title: string;
  preview: string;
  status: HomeDayItemStatus;
  statusLabel: string;
  updatedAt: string;
  href: string;
  room: {
    id: string;
    name: string;
    color: string;
    icon: string;
  };
}

export interface HomeDayChatItem extends HomeDayBaseItem {
  kind: "chat";
  chat: {
    id: string;
    unread: boolean;
    running: boolean;
    failed: boolean;
    latestFailedMessageId: string | null;
  };
}

export interface HomeDayTaskItem extends HomeDayBaseItem {
  kind: "task";
  task: Message;
}

export type HomeDayItem = HomeDayChatItem | HomeDayTaskItem;

export interface HomeDayResponse {
  refreshedAt: string;
  counts: {
    needsInput: number;
    active: number;
    done: number;
  };
  sections: {
    needsInput: HomeDayItem[];
    active: HomeDayItem[];
    done: HomeDayItem[];
  };
}

type HomeBucket = keyof HomeDayResponse["sections"];

interface RoomInfo {
  id: string;
  name: string;
  color: string;
  icon: string;
}

interface ChatInfo {
  id: string;
  workspaceId: string;
}

function roomFromWorkspace(workspace: Workspace): RoomInfo {
  return {
    id: workspace.id,
    name: workspace.name,
    color: workspace.color,
    icon: workspace.icon,
  };
}

function newestTime(item: { updatedAt: string }): number {
  const ms = Date.parse(item.updatedAt);
  return Number.isFinite(ms) ? ms : 0;
}

function sortNewestFirst(items: HomeDayItem[]): HomeDayItem[] {
  return [...items].sort((a, b) => newestTime(b) - newestTime(a));
}

function titleFromTask(message: Message): string {
  const title = message.title?.trim();
  if (title) return title;
  const preview = messageTextPreview(message).trim();
  const first = preview.split("\n")[0]?.trim();
  return first || "Untitled";
}

function chatHref(workspaceId: string, chatId: string): string {
  return `/w/${encodeURIComponent(workspaceId)}/pinned?chat=${encodeURIComponent(chatId)}`;
}

function taskHref(workspaceId: string, taskId: string): string {
  return `/w/${encodeURIComponent(workspaceId)}/tasks?task=${encodeURIComponent(taskId)}`;
}

function taskUpdatedAt(message: Message): string {
  return message.endedAt ?? message.updatedAt ?? message.createdAt;
}

async function listTasksForStatus(
  pool: Pool,
  userId: string,
  taskStatus: "needs_input" | "active" | "complete",
): Promise<Message[]> {
  const result = await queries.messages.listCrossChat(pool, {
    userId,
    kinds: ["task"],
    taskStatuses: [taskStatus],
    limit: TASK_BUCKET_LIMIT,
    view: "compact",
  });
  return result.items;
}

async function chatInfoById(
  pool: Pool,
  chatIds: string[],
): Promise<Map<string, ChatInfo>> {
  const unique = Array.from(new Set(chatIds)).filter(Boolean);
  if (unique.length === 0) return new Map();
  const placeholders = unique.map(() => "?").join(", ");
  const { rows } = await pool.query<{
    id: string;
    workspace_id: string;
  }>(
    `SELECT id, workspace_id FROM chats WHERE id IN (${placeholders})`,
    unique,
  );
  return new Map(rows.map((r) => [r.id, { id: r.id, workspaceId: r.workspace_id }]));
}

async function latestFailedAgentTurnByChatId(
  pool: Pool,
  chatIds: string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(chatIds)).filter(Boolean);
  if (unique.length === 0) return new Map();
  const placeholders = unique.map(() => "?").join(", ");
  const { rows } = await pool.query<{
    id: string;
    chat_id: string;
  }>(
    `SELECT id, chat_id
       FROM messages
      WHERE chat_id IN (${placeholders})
        AND state = 'failed'
        AND json_valid(content)
        AND json_extract(content, '$.type') = 'agent_turn'
      ORDER BY chat_id ASC, created_at DESC, rowid DESC`,
    unique,
  );
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!result.has(row.chat_id)) result.set(row.chat_id, row.id);
  }
  return result;
}

function taskItem(
  message: Message,
  bucket: HomeBucket,
  room: RoomInfo,
): HomeDayItem {
  const { status, statusLabel } = statusForBucket(bucket);
  return {
    kind: "task",
    id: message.id,
    title: titleFromTask(message),
    preview: messageTextPreview(message).trim(),
    status,
    statusLabel,
    updatedAt: taskUpdatedAt(message),
    href: taskHref(room.id, message.id),
    room,
    task: message,
  };
}

function statusForBucket(bucket: HomeBucket): {
  status: HomeDayItemStatus;
  statusLabel: string;
} {
  if (bucket === "needsInput") {
    return { status: "needs_input", statusLabel: "Needs input" };
  }
  if (bucket === "active") {
    return { status: "active", statusLabel: "Active" };
  }
  return { status: "done", statusLabel: "Done" };
}

function chatItem(
  chat: ChatWithListMeta,
  bucket: HomeBucket,
  room: RoomInfo,
  latestFailedMessageId: string | null,
): HomeDayItem {
  const { status, statusLabel } = statusForBucket(bucket);
  return {
    kind: "chat",
    id: chat.id,
    title: chat.title.trim() || "Untitled",
    preview: chat.lastMessage?.trim() ?? "",
    status,
    statusLabel,
    updatedAt: chat.updatedAt,
    href: chatHref(room.id, chat.id),
    room,
    chat: {
      id: chat.id,
      unread: chat.unread,
      running: !!chat.running,
      failed: !!chat.failed,
      latestFailedMessageId,
    },
  };
}

export async function getHomeDay(
  pool: Pool,
  userId: string,
): Promise<HomeDayResponse> {
  const workspaces = (await queries.workspaces.listByUser(pool, userId))
    .filter((workspace) => workspace.kind !== "hub");
  const roomByWorkspace = new Map(
    workspaces.map((workspace) => [workspace.id, roomFromWorkspace(workspace)]),
  );

  const [needsInputTasks, activeTasks, doneTasks] = await Promise.all([
    listTasksForStatus(pool, userId, "needs_input"),
    listTasksForStatus(pool, userId, "active"),
    listTasksForStatus(pool, userId, "complete"),
  ]);
  const allTaskMessages = [
    ...needsInputTasks,
    ...activeTasks,
    ...doneTasks,
  ];
  const taskChatInfo = await chatInfoById(
    pool,
    allTaskMessages.flatMap((message) => [
      message.chatId,
      message.threadChatId ?? "",
    ]),
  );

  const taskItemsFor = (messages: Message[], bucket: HomeBucket): HomeDayItem[] =>
    messages.flatMap((message) => {
      const target = taskChatInfo.get(message.threadChatId ?? message.chatId);
      if (!target) return [];
      const room = roomByWorkspace.get(target.workspaceId);
      if (!room) return [];
      return [taskItem(message, bucket, room)];
    });

  const needsInput = taskItemsFor(needsInputTasks, "needsInput");
  const active = taskItemsFor(activeTasks, "active");
  const done = taskItemsFor(doneTasks, "done");
  const taskChatIds = new Set([
    ...needsInput,
    ...active,
    ...done,
  ].flatMap((item) => item.kind === "task"
    ? [item.task.chatId, item.task.threadChatId ?? ""]
    : [],
  ).filter(Boolean));

  const recentCutoff = Date.now() - DONE_WINDOW_MS;
  for (const workspace of workspaces) {
    const room = roomByWorkspace.get(workspace.id);
    if (!room) continue;
    const chats = await queries.chats.listWithLatestMessage(pool, workspace.id);
    const latestFailedByChatId = await latestFailedAgentTurnByChatId(
      pool,
      chats.filter(chat => chat.failed).map(chat => chat.id),
    );
    for (const chat of chats) {
      // Task/task_run chats are represented by typed task rows. Keeping
      // them out here avoids duplicated cards on Home.
      if (taskChatIds.has(chat.id)) continue;
      if (chat.kind === "task" || chat.kind === "task_run") continue;
      const latestFailedMessageId = latestFailedByChatId.get(chat.id) ?? null;
      if (chat.running) {
        active.push(chatItem(chat, "active", room, latestFailedMessageId));
      } else if (chat.unread || chat.failed) {
        needsInput.push(chatItem(chat, "needsInput", room, latestFailedMessageId));
      } else if (newestTime({ updatedAt: chat.updatedAt }) >= recentCutoff) {
        done.push(chatItem(chat, "done", room, latestFailedMessageId));
      }
    }
  }

  const sections = {
    needsInput: sortNewestFirst(needsInput),
    active: sortNewestFirst(active),
    done: sortNewestFirst(done).slice(0, DONE_LIMIT),
  };

  return {
    refreshedAt: new Date().toISOString(),
    counts: {
      needsInput: sections.needsInput.length,
      active: sections.active.length,
      done: sections.done.length,
    },
    sections,
  };
}
