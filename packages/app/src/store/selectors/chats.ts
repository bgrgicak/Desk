import type { Chat as UiChat } from "@/data/ui-types";
import type { ServerChat } from "../types";

/**
 * Map a server Chat to the shape the existing React components already
 * consume. Fields the server can't populate yet stay empty/undefined with
 * a TODO — see matrix §4.
 */
export function toUiChat(c: ServerChat): UiChat {
  return {
    id: c.id,
    title: c.title,
    lastMessage: "", // TODO(api-gap): derive from last message fetched per chat
    updatedAt: new Date(c.updatedAt),
    createdAt: new Date(c.createdAt),
    artifactIds: [], // populated by slice 8
    messages: [], // populated by slice 4
    unread: c.unread,
    running: c.running,
    failed: c.failed,
    workspaceId: c.workspaceId,
    agentId: c.agentId,
    goal: c.goal ?? null,
    kind: c.kind,
  };
}
