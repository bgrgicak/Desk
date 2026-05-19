import type { Chat as UiChat } from "@/data/ui-types";
import type { ServerChat } from "../types";

/**
 * Map a server Chat to the shape the existing React components
 * consume.  Date strings are parsed to Date objects, optional fields
 * default to empty/false, and the chat-level `artifactIds` and
 * `messages` collections are populated later by other slices (the
 * server doesn't ship them on the chat resource).
 */
export function toUiChat(c: ServerChat): UiChat {
  return {
    id: c.id,
    title: c.title,
    // Server fills lastMessage on /chats list responses (correlated
    // subquery against the latest user/agent text message). WS
    // chat.updated events omit it; the sidebar refetch on chat-list
    // invalidation picks up the new preview.
    lastMessage: c.lastMessage ?? "",
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
