import type { Chat as UiChat, ChatGoalKind } from "@/data/ui-types";
import { GOAL_KEYS } from "@agent-desk/shared";
import type { ServerChat } from "../types";

const VALID_CHAT_GOALS = new Set<string>(GOAL_KEYS);

/**
 * Narrow the server's free-form `goal` string to the
 * client's `ChatGoalKind` union, falling back to `null` for
 * unknown / missing values.  The server's ChatSchema currently
 * accepts any string (the DB column has no enum constraint); the
 * client only renders the known set.
 *
 * Exported for direct unit testing — exhaustive coverage of the
 * narrow + fallback paths sits alongside the helper.
 */
export function narrowChatGoal(goal: string | undefined): ChatGoalKind | null {
  if (!goal) return null;
  return VALID_CHAT_GOALS.has(goal) ? (goal as ChatGoalKind) : null;
}

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
    goal: narrowChatGoal(c.goal),
    kind: c.kind,
  };
}
