import type { Run, RunOccurrence } from "@/data/ui-types";
import type { ServerAgent, ServerMessage } from "../types";

const COLOR_PALETTE: Run["color"][] = [
  "blue",
  "emerald",
  "amber",
  "violet",
  "slate",
  "rose",
  "orange",
];

function colorFor(id: string): Run["color"] {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return COLOR_PALETTE[Math.abs(h) % COLOR_PALETTE.length];
}

function nameFor(m: ServerMessage): string {
  if (m.content.type === "text") {
    const first = m.content.text.split("\n")[0].trim();
    return first.length > 0 ? first : "(empty)";
  }
  if (m.content.type === "note") return m.content.body.split("\n")[0].trim();
  return m.content.type;
}

function statusFor(m: ServerMessage): Run["status"] {
  if (m.state === "running") return "active";
  if (m.state === "succeeded") return "completed";
  if (m.state === "failed") return "failed";
  if (m.state === "cancelled") return "completed";
  if (m.state === "paused") return "paused";
  if (m.state === "pending") return "scheduled";
  return "scheduled";
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
 * Map a scheduled/executing server Message to the client Run shape. Fields
 * the server can't carry (history per-occurrence, end times on recurring
 * runs) are left empty; they'll stay client-side TODOs until the run log
 * surface is wired up (slice 12).
 */
export function toUiRun(m: ServerMessage, agents: ServerAgent[]): Run {
  const agent = agents.find((a) => a.id === m.agentId);
  const realStartedAt = m.startedAt ? new Date(m.startedAt) : undefined;
  const completedAt = m.endedAt ? new Date(m.endedAt) : undefined;
  const status = statusFor(m);

  // `history` actually holds *all* occurrences the Runs surfaces know
  // about — past executions and the upcoming one. The calendar/list
  // views place anything here onto a date; the detail panel's
  // "History" section filters to real past ones. A pending/paused
  // message with an executeAt still gets a synthesized preview row
  // (status: 'scheduled'|'paused') so it shows up on the calendar at
  // its scheduled date. Once slice 12 emits real per-occurrence
  // history, this synthesized row drops out in favour of the real
  // rows returned by the server.
  const history: RunOccurrence[] = [];
  if (realStartedAt) {
    const occStatus: RunOccurrence["status"] =
      m.state === "running" ? "active"
      : m.state === "succeeded" ? "completed"
      : m.state === "failed" ? "failed"
      : m.state === "cancelled" ? "paused"
      : "active";
    history.push({
      id: `${m.id}-occ`,
      startedAt: realStartedAt,
      endedAt: completedAt ?? realStartedAt,
      status: occStatus,
    });
  } else if (m.executeAt && m.state !== "cancelled") {
    // Synthesize an upcoming occurrence preview so the calendar + list
    // views have somewhere to place a scheduled-but-not-yet-fired run.
    // Message rows without an explicit `state` (e.g. a user message a
    // client PATCHed executeAt onto) are treated as pending for
    // display — they never actually fire, but the Runs surfaces still
    // need to show them.
    const when = new Date(m.executeAt);
    history.push({
      id: `${m.id}-upcoming`,
      startedAt: when,
      endedAt: when,
      status: m.state === "paused" ? "paused" : "scheduled",
    });
  }

  // `startedAt` on the Run shape is consumed by the "Last run" label and
  // the calendar row. Use the real execution time when we have one;
  // otherwise fall back to createdAt so the Run still sorts stably in
  // lists — RunDetailPanel gates the "Last run" UI on hasRealStartedAt
  // so we never claim a scheduled-but-never-fired run ran "just now".
  const startedAt = realStartedAt ?? new Date(m.createdAt);

  // Paused cron runs still have a schedule but shouldn't advertise a
  // nextRun until resumed (we dropped the schedulerRef); paused at-runs
  // keep executeAt for display purposes but the scheduler won't fire it.
  const nextRun = m.state === "paused"
    ? undefined
    : m.executeAt ? new Date(m.executeAt) : undefined;

  return {
    id: m.id,
    name: nameFor(m),
    agentName: agent?.name ?? "Agent",
    status,
    statusText: statusTextFor(m),
    startedAt,
    hasRealStartedAt: !!realStartedAt,
    completedAt,
    chatId: m.chatId,
    messageId: m.id,
    artifactIds: [],
    scheduled: !!(m.executeAt || m.cron),
    nextRun,
    color: colorFor(m.id),
    schedule: m.cron,
    history,
  };
}
