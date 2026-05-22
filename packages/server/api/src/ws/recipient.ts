import { type Pool, queries } from "@roomy-ai/db";
import type { WsEvent } from "@roomy-ai/shared";

/**
 * Resolves the recipient userId for a WS event so the broadcaster can fan
 * it out to the right account.
 *
 * Before multi-user, the server held a single boot-time `broadcastUserId`
 * (`SELECT id FROM users LIMIT 1`) and aimed every event at it. With the
 * signup wizard, the DB has more than one row in `users` — and the
 * boot-time pick was almost always the *seed* account, not whoever was
 * signed in, so live updates silently dropped for every other user.
 *
 * Every `WsEvent` variant ultimately ties back to a workspace, and every
 * workspace has one owner. We derive that owner from whichever id the
 * event carries (workspaceId → user, or chatId → workspace → user, or
 * messageId → chat → workspace → user). Results are memoised — the
 * workspace/user binding never changes for a given chat or workspace
 * row, so subsequent events for the same chat skip the DB entirely
 * (critical for streaming log events, which fan out per stdout line).
 *
 * Returns `null` when the event references nothing resolvable; callers
 * (`emitEvent`) drop those silently rather than guessing.
 */
const userIdByWorkspace = new Map<string, string>();
const userIdByChat = new Map<string, string>();
const chatIdByMessage = new Map<string, string>();

/**
 * Soft cap on each cache so a long-lived server doesn't accrete entries
 * forever (chats are deleted, workspaces churn during development).
 * On overflow we wipe the oldest half — cheap, no LRU bookkeeping
 * overhead, and the next emit just refills from the DB. The number is
 * generous enough that production-scale chats stay hot indefinitely.
 */
const MAX_CACHE_ENTRIES = 10_000;

function memoize(map: Map<string, string>, key: string, value: string): void {
  if (map.size >= MAX_CACHE_ENTRIES) {
    const keys = Array.from(map.keys()).slice(0, Math.floor(MAX_CACHE_ENTRIES / 2));
    for (const k of keys) map.delete(k);
  }
  map.set(key, value);
}

async function userIdForWorkspace(pool: Pool, workspaceId: string): Promise<string | null> {
  const cached = userIdByWorkspace.get(workspaceId);
  if (cached) return cached;
  const ws = await queries.workspaces.findById(pool, workspaceId);
  if (!ws) return null;
  memoize(userIdByWorkspace, workspaceId, ws.userId);
  return ws.userId;
}

async function userIdForChat(pool: Pool, chatId: string): Promise<string | null> {
  const cached = userIdByChat.get(chatId);
  if (cached) return cached;
  const chat = await queries.chats.findById(pool, chatId);
  if (!chat) return null;
  const userId = await userIdForWorkspace(pool, chat.workspaceId);
  if (!userId) return null;
  memoize(userIdByChat, chatId, userId);
  return userId;
}

async function chatIdForMessage(pool: Pool, messageId: string): Promise<string | null> {
  const cached = chatIdByMessage.get(messageId);
  if (cached) return cached;
  const msg = await queries.messages.findById(pool, messageId);
  if (!msg) return null;
  memoize(chatIdByMessage, messageId, msg.chatId);
  return msg.chatId;
}

export async function resolveRecipientUserId(
  pool: Pool,
  event: WsEvent,
): Promise<string | null> {
  switch (event.type) {
    case "chat.updated":
      return userIdForWorkspace(pool, event.payload.workspaceId);
    case "chat.deleted":
      return userIdForWorkspace(pool, event.payload.workspaceId);
    case "message.appended": {
      // `event.workspaceId` is populated by chat-route emitters; fall back
      // to the payload's chatId for paths that ship the bare message.
      if (event.workspaceId) return userIdForWorkspace(pool, event.workspaceId);
      return userIdForChat(pool, event.payload.chatId);
    }
    case "message.updated":
      return userIdForChat(pool, event.payload.chatId);
    case "message.streaming":
      return userIdForChat(pool, event.payload.chatId);
    case "message.log_appended": {
      const chatId = await chatIdForMessage(pool, event.payload.messageId);
      if (!chatId) return null;
      return userIdForChat(pool, chatId);
    }
    case "artifact.created": {
      // FileSchema carries only `path`. Chat artifacts live under
      // `<workspace-slug>/.chats/{chatId}/…`, which the chat-resource
      // emitters guarantee. We crack the chatId out of the path so a
      // freshly-uploaded attachment fans out without a separate lookup
      // by path on disk.
      const m = event.payload.path.match(/\.chats\/([^/]+)\//);
      if (!m) return null;
      return userIdForChat(pool, m[1]);
    }
    case "library.changed":
      return userIdForWorkspace(pool, event.payload.workspaceId);
    case "workspace.synced":
      return userIdForWorkspace(pool, event.payload.workspaceId);
    case "connection.changed": {
      // Workspace-scoped grants identify the recipient directly; global
      // connector changes don't, and the caller has to thread the
      // userId through (see refreshConnections in app.ts).
      if (event.payload.workspaceId) {
        return userIdForWorkspace(pool, event.payload.workspaceId);
      }
      return null;
    }
  }
}

/** For tests — wipes all caches so leaked entries don't cross suites. */
export function clearRecipientCaches(): void {
  userIdByWorkspace.clear();
  userIdByChat.clear();
  chatIdByMessage.clear();
}
