import type { InboxItem } from "@/data/mock-data";
import type { ServerAgent, ServerMessage } from "../types";

function typeFor(m: ServerMessage): InboxItem["type"] {
  // Everything on the inbox strip is an awaiting-user item; we just need
  // to pick a visual bucket. Failed runs show as errors; other awaiting
  // states surface as questions. Completions come from /messages where
  // state === "succeeded" and stay behind the "completion" bucket.
  if (m.state === "failed") return "error";
  if (m.state === "succeeded") return "completion";
  return "question";
}

function messageFor(m: ServerMessage): string {
  if (m.content.type === "text") return m.content.text;
  if (m.content.type === "note") return m.content.body;
  return `(${m.content.type})`;
}

export function toInboxItem(
  m: ServerMessage,
  agents: ServerAgent[],
): InboxItem {
  const agent = agents.find((a) => a.id === m.agentId);
  return {
    id: m.id,
    type: typeFor(m),
    agentName: agent?.name ?? "Agent",
    message: messageFor(m),
    timestamp: new Date(m.createdAt),
    read: false,
    artifactId: undefined,
    runId: m.chatId,
    quickReplies: undefined,
    uiCard: undefined,
  };
}
