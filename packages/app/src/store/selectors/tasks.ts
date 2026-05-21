import type { Task, TaskOccurrence } from "@/data/ui-types";
import { taskStatusFromTaskAndRuns } from "@/lib/task-status";
import type { ServerAgent, ServerChat, ServerMessage, ServerWorkspace } from "../types";

export function taskMessageKindsForDeveloperMode(_developerMode: boolean): Array<"task" | "summary"> {
  return ["task"];
}

export function summaryRequestMessageKindsForDeveloperMode(developerMode: boolean): Array<"summary"> {
  return developerMode ? ["summary"] : [];
}

export function isTaskListMessageForDeveloperMode(m: ServerMessage, developerMode: boolean): boolean {
  if (m.kind === "task") {
    if (!developerMode && m.content.type === "reflection_request") return false;
    return true;
  }
  if (!developerMode) return false;
  return m.kind === "summary" && m.content.type === "summary_request";
}

export function taskRunMessageKinds(): Array<"task_run"> {
  return ["task_run"];
}

const COLOR_PALETTE: Task["color"][] = [
  "blue",
  "emerald",
  "amber",
  "violet",
  "slate",
  "rose",
  "orange",
];

function colorFor(id: string): Task["color"] {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return COLOR_PALETTE[Math.abs(h) % COLOR_PALETTE.length];
}

function nameFor(m: ServerMessage, chats: ServerChat[], workspaces: ServerWorkspace[]): string {
  if (m.content.type === "summary_request") {
    const embeddedTitle = m.content.chatTitle?.trim();
    const chatTitle = embeddedTitle || chats.find((chat) => chat.id === m.chatId)?.title.trim();
    return chatTitle ? `Summarize - ${chatTitle}` : "Summarize";
  }
  if (m.content.type === "reflection_request") {
    const workspaceId = m.content.workspaceId;
    const workspaceName = workspaces.find((ws) => ws.id === workspaceId)?.name.trim();
    return workspaceName ? `Reflect - ${workspaceName}` : "Reflect";
  }
  if (m.title && m.title.trim().length > 0) return m.title;
  if (m.content.type === "text") {
    const first = m.content.text.split("\n")[0].trim();
    return first.length > 0 ? first : "(empty)";
  }
  if (m.content.type === "summary") return m.content.body.split("\n")[0].trim();
  return m.content.type;
}

function descriptionFor(m: ServerMessage): string | undefined {
  if (m.content.type === "summary_request") {
    const preview = m.content.messagePreview?.trim();
    return preview && preview !== m.content.chatTitle?.trim() ? preview : undefined;
  }
  if (m.content.type !== "text") return undefined;
  const text = m.content.text.trim();
  if (!text) return undefined;
  if (m.title && text === m.title) return undefined;
  if (m.title && text.startsWith(`${m.title}\n`)) {
    const withoutTitle = text.slice(m.title.length).trim();
    return withoutTitle.length > 0 ? withoutTitle : undefined;
  }
  if (m.title) return text;
  const [, ...rest] = text.split("\n");
  const description = rest.join("\n").trim();
  return description.length > 0 ? description : undefined;
}

function statusFor(
  m: ServerMessage,
  runs: ServerMessage[] = [],
  chat?: ServerChat,
): Task["status"] {
  return taskStatusFromTaskAndRuns(
    { state: m.state ?? "pending", executeAt: m.executeAt, cron: m.cron },
    runs.map(run => ({ state: run.state })),
    chat ? { unread: chat.unread, running: chat.running } : undefined,
  );
}

function statusTextFor(
  m: ServerMessage,
  chat?: ServerChat,
  runs: ServerMessage[] = [],
): string {
  // Real execution signals first — match the badge in task-status.ts so the
  // helper text never says "Running" on a card that isn't actually running.
  // A parent task's own state='running' is a kanban label, not execution,
  // so it does not flip the text on its own.
  if (runs.some(run => run.state === "running")) return "Running";
  if (chat?.running) return "Agent working…";
  if (m.state === "succeeded") return "Completed";
  if (m.state === "failed") return "Failed";
  if (m.state === "cancelled") return "Cancelled";
  if (m.state === "paused") {
    if (m.cron) return `Paused — cron: ${m.cron}`;
    if (m.executeAt) return `Paused — was scheduled for ${new Date(m.executeAt).toLocaleString()}`;
    return "Paused";
  }
  if (m.executeAt) {
    const when = new Date(m.executeAt);
    const label = when.toLocaleString();
    return when.getTime() < Date.now() ? `Overdue since ${label}` : `Scheduled for ${label}`;
  }
  if (m.cron) return `Cron: ${m.cron}`;
  if (chat?.unread) return "Waiting for your reply";
  return "Pending";
}

export function taskOccurrenceFromMessage(m: ServerMessage): TaskOccurrence | undefined {
  const startedAt = m.startedAt ? new Date(m.startedAt) : undefined;
  if (!startedAt && !m.executeAt) return undefined;

  const occStartedAt = startedAt ?? new Date(m.executeAt!);
  const endedAt = m.endedAt ? new Date(m.endedAt) : occStartedAt;
  const status: TaskOccurrence["status"] =
    m.state === "running" ? "active"
    : m.state === "failed" ? "failed"
    : m.state === "pending" || m.state === "paused" ? "scheduled"
    : "completed";

  return {
    id: m.kind === "task_run" ? m.id : `${m.id}-occ`,
    startedAt: occStartedAt,
    endedAt,
    status,
    statusText: statusTextFor(m),
  };
}

/**
 * Convert a scheduled/executing server Message into the trunk-derived
 * Task shape that the Tasks page renders. `priority`, `assigneeId`,
 * `color`, free-form `schedule`, and `history` per-occurrence are
 * client-derived — the server doesn't carry them yet.
 */
export function toUiTask(
  m: ServerMessage,
  agents: ServerAgent[],
  chats: ServerChat[] = [],
  workspaces: ServerWorkspace[] = [],
  runs: ServerMessage[] = [],
): Task {
  const agent = agents.find((a) => a.id === m.agentId);
  // For a sub-task, the agent runs inside the dedicated thread chat —
  // that's where messages-writes.ts flips `unread = 1` when the agent
  // posts, and where `running` reflects the live agent_turn. Reading
  // unread/running off the parent chat would surface false negatives
  // (the parent chat stays unread=false while the sub-task thread
  // accumulates agent replies) and the task would never show as
  // `needs_input` until the user opened the thread themselves.
  const chat = chats.find((c) => c.id === (m.threadChatId ?? m.chatId));
  const realStartedAt = m.startedAt ? new Date(m.startedAt) : undefined;
  const completedAt = m.endedAt ? new Date(m.endedAt) : undefined;
  const status = statusFor(m, runs, chat);

  const history: TaskOccurrence[] = [];
  for (const run of runs) {
    const occurrence = taskOccurrenceFromMessage(run);
    if (occurrence) history.push(occurrence);
  }
  if (realStartedAt) {
    const occurrence = taskOccurrenceFromMessage(m);
    if (occurrence) history.push(occurrence);
  } else if (m.executeAt && m.state !== "cancelled") {
    const when = new Date(m.executeAt);
    history.push({
      id: `${m.id}-upcoming`,
      startedAt: when,
      endedAt: when,
      status: "scheduled",
    });
  }

  const startedAt = realStartedAt ?? new Date(m.createdAt);
  const nextRun = m.state === "paused"
    ? undefined
    : m.executeAt ? new Date(m.executeAt) : undefined;

  return {
    id: m.id,
    name: nameFor(m, chats, workspaces),
    title: m.title?.trim() || undefined,
    description: descriptionFor(m),
    agentName: agent?.name ?? "Agent",
    status,
    statusText: statusTextFor(m, chat, runs),
    // The server has no `assigneeId` field — task assignment is just
    // `agentId`.  Drop the dead alias (PATCH bodies that included it
    // were silently no-op on the server) and use the row's agentId.
    assigneeId: agent?.id,
    startedAt,
    hasRealStartedAt: !!realStartedAt,
    completedAt,
    messageKind: m.kind,
    messageContentType: m.content.type,
    messageRole: m.role,
    messageState: m.state ?? "pending",
    chatId: m.chatId,
    threadChatId: m.threadChatId,
    messageId: m.id,
    artifactIds: [],
    scheduledFor: m.executeAt ? new Date(m.executeAt) : undefined,
    nextRun,
    color: colorFor(m.id),
    schedule: m.cron,
    history,
  };
}
