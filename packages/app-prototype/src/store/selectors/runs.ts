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
  if (m.state === "cancelled") return "paused";
  if (m.state === "pending") return "active";
  return "active";
}

function statusTextFor(m: ServerMessage): string {
  if (m.state === "running") return "Running";
  if (m.state === "succeeded") return "Completed";
  if (m.state === "failed") return "Failed";
  if (m.state === "cancelled") return "Cancelled";
  if (m.executeAt) return `Scheduled for ${new Date(m.executeAt).toLocaleString()}`;
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
  const startedAt = m.startedAt
    ? new Date(m.startedAt)
    : m.executeAt
      ? new Date(m.executeAt)
      : new Date(m.createdAt);
  const completedAt = m.endedAt ? new Date(m.endedAt) : undefined;
  const status = statusFor(m);
  // Derive a single occurrence from the server's state/timestamps so the
  // Runs calendar has something to place. Recurring cron runs will need
  // server-side history to render multiple rows.
  const occStatus: RunOccurrence["status"] =
    status === "completed" || status === "failed" ? status : "active";
  const history: RunOccurrence[] = [
    {
      id: `${m.id}-occ`,
      startedAt,
      endedAt: completedAt ?? startedAt,
      status: occStatus,
    },
  ];
  return {
    id: m.id,
    name: nameFor(m),
    agentName: agent?.name ?? "Agent",
    status,
    statusText: statusTextFor(m),
    startedAt,
    completedAt,
    artifactIds: [],
    scheduled: !!(m.executeAt || m.cron),
    nextRun: m.executeAt ? new Date(m.executeAt) : undefined,
    color: colorFor(m.id),
    schedule: m.cron,
    history,
  };
}
