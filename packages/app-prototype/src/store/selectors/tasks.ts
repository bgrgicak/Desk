import type { Task, TaskOccurrence } from "@/data/ui-types";
import type { ServerAgent, ServerMessage } from "../types";

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

function nameFor(m: ServerMessage): string {
  if (m.title && m.title.trim().length > 0) return m.title;
  if (m.content.type === "text") {
    const first = m.content.text.split("\n")[0].trim();
    return first.length > 0 ? first : "(empty)";
  }
  if (m.content.type === "note") return m.content.body.split("\n")[0].trim();
  return m.content.type;
}

/**
 * Maps a task message to its board column. The discriminator is the
 * schedule shape, not state alone:
 *   - `cron` set      → "active" (recurring tasks are always active)
 *   - state=running   → "active" (transient, while the agent fires)
 *   - state terminal  → "complete" (succeeded / failed / cancelled)
 *   - executeAt set   → "scheduled" (one-shot, hasn't fired yet)
 *   - otherwise       → "todo" (manual task, no schedule, no agent action)
 *
 * Manual tasks stay in "todo" until the user explicitly moves them — the
 * agent has no path to mutate their column-state, since unscheduled tasks
 * never fire.
 */
function statusFor(m: ServerMessage): Task["status"] {
  if (m.cron) return "active";
  if (m.state === "running") return "active";
  if (m.state === "succeeded" || m.state === "failed" || m.state === "cancelled") return "complete";
  if (m.executeAt) return "scheduled";
  return "todo";
}

function statusTextFor(m: ServerMessage): string {
  if (m.state === "running") return "Running";
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
  return "Pending";
}

/**
 * Convert a scheduled/executing server Message into the trunk-derived
 * Task shape that the Tasks page renders. `priority`, `assigneeId`,
 * `color`, free-form `schedule`, and `history` per-occurrence are
 * client-derived — the server doesn't carry them yet.
 */
export function toUiTask(m: ServerMessage, agents: ServerAgent[]): Task {
  const agent = agents.find((a) => a.id === m.agentId);
  const realStartedAt = m.startedAt ? new Date(m.startedAt) : undefined;
  const completedAt = m.endedAt ? new Date(m.endedAt) : undefined;
  const status = statusFor(m);

  const history: TaskOccurrence[] = [];
  if (realStartedAt) {
    const occStatus: TaskOccurrence["status"] =
      m.state === "running" ? "active"
      : m.state === "succeeded" ? "completed"
      : m.state === "failed" ? "failed"
      : "completed";
    history.push({
      id: `${m.id}-occ`,
      startedAt: realStartedAt,
      endedAt: completedAt ?? realStartedAt,
      status: occStatus,
    });
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
    name: nameFor(m),
    agentName: agent?.name ?? "Agent",
    status,
    statusText: statusTextFor(m),
    assigneeId: agent?.id,
    startedAt,
    hasRealStartedAt: !!realStartedAt,
    completedAt,
    chatId: m.chatId,
    messageId: m.id,
    artifactIds: [],
    scheduledFor: m.executeAt ? new Date(m.executeAt) : undefined,
    nextRun,
    color: colorFor(m.id),
    schedule: m.cron,
    history,
  };
}
