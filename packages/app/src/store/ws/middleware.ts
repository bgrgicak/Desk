import type { Middleware } from "@reduxjs/toolkit";
import { createAction } from "@reduxjs/toolkit";
import { api } from "../api";
import { pushArtifactUpdate, bumpFileChangeCounter, bumpWorkspaceChangeCounter, markChatRunning, markChatIdle, markChatFailed, clearChatFailed, clearWsKnownChatIds, selectCurrentUserId } from "../slices/derivedSlice";
import type { RootState } from "../store";
import { getSessionToken } from "@/auth/session";
import type { AgentEvent, AgentLogEntry, ListMessagesResponse, MessagesFilter, ServerChat, ServerMessage, WsEvent } from "../types";
import { isInternalChatMessage, maybeShowChatBrowserNotification } from "@/lib/account-notifications";

const pendingProgressLogByMessageId = new Map<string, AgentLogEntry[]>();

function mergeProgressLog(msg: ServerMessage, existing?: AgentLogEntry[]): ServerMessage {
  const pending = pendingProgressLogByMessageId.get(msg.id) ?? [];
  const merged = [...(existing ?? []), ...(msg.progressLog ?? []), ...pending];
  if (merged.length === 0) return msg;
  pendingProgressLogByMessageId.delete(msg.id);
  return { ...msg, progressLog: merged };
}

function compactTimelineMessage(msg: ServerMessage): ServerMessage | null {
  if (msg.content.type === "summary" || msg.content.type === "summary_request" || msg.content.type === "reflection_request") {
    return null;
  }

  switch (msg.content.type) {
    case "events": {
      const log: typeof msg.content.log = [];
      let sawStructuredEvent = false;
      for (const entry of msg.content.log) {
        if (entry.kind === "event") {
          sawStructuredEvent = true;
          if (entry.event.type === "text") {
            const text = entry.event.part?.text;
            if (typeof text === "string") {
              log.push({ kind: "event", event: { type: "text", part: { text } } });
            }
          }
        } else if (entry.kind === "unparsed" && !sawStructuredEvent) {
          log.push(entry);
        }
      }
      return { ...msg, content: { type: "events", log } };
    }
    case "toolCall":
      return { ...msg, content: { type: "toolCall", toolName: msg.content.toolName, args: {} } };
    case "toolResult":
      return { ...msg, content: { type: "toolResult", toolName: msg.content.toolName, result: null } };
    default:
      return msg;
  }
}

/**
 * Optimistic cache patcher: sets `unread: false` for a chat in every
 * `getChats` cache entry (both the unscoped and any workspace-scoped
 * variants) and in the direct `getChat` cache used by hidden/internal
 * chats opened from notification URLs.
 *
 * The app only calls `useGetChatsQuery({ workspaceId })`, so the
 * unscoped cache is typically empty. We iterate the RTK Query cache
 * keys to find which workspace-scoped queries exist and patch all of
 * them. Without this, the optimistic `unread: false` patch would
 * silently miss the workspace-scoped cache and the sidebar dot would
 * flash until the server confirms via `chat.updated`.
 */
function patchChatUnreadInCache(
  dispatch: (a: unknown) => unknown,
  chatId: string,
  getState?: () => unknown,
): void {
  const patch = (draft: ServerChat[]) => {
    const idx = draft.findIndex((c) => c.id === chatId);
    if (idx >= 0 && draft[idx].unread) {
      draft[idx] = { ...draft[idx], unread: false };
    }
  };
  const patchSingle = (draft: ServerChat) => {
    if (draft.unread) draft.unread = false;
  };
  // Always try the unscoped cache (cheap no-op when it doesn't exist).
  dispatch(api.util.updateQueryData("getChats", undefined, patch));
  dispatch(api.util.updateQueryData("getChat", chatId, patchSingle));

  // Also patch every workspace-scoped cache that exists. The RTK Query
  // state under `api.reducerPath` stores each query's `data` keyed by
  // the serialized args. We inspect the cache to find which workspaceId
  // queries are live and patch each one, so the sidebar's workspace-
  // scoped `useGetChatsQuery({ workspaceId })` picks up unread=false
  // immediately.
  if (getState) {
    const state = getState() as Record<string, unknown>;
    const apiState = state[api.reducerPath] as { queries?: Record<string, { data?: ServerChat[] }> } | undefined;
    if (apiState?.queries) {
      for (const [key, entry] of Object.entries(apiState.queries)) {
        if (!key.startsWith("getChats(")) continue;
        const chats = entry?.data;
        if (!Array.isArray(chats)) continue;
        const chat = chats.find((c: ServerChat) => c.id === chatId);
        if (!chat) continue;
        dispatch(
          api.util.updateQueryData("getChats", { workspaceId: chat.workspaceId }, patch),
        );
      }
    }
  }
}

/**
 * Non-internal message appends bump `chats.updated_at` on the server, which is
 * what the sidebar sorts by. When the message belongs to the currently viewed
 * chat we intentionally avoid invalidating the chat list (to prevent unread-dot
 * flashes), so mirror that timestamp bump in any live chat-list cache.
 */
function patchChatActivityInCache(
  dispatch: (a: unknown) => unknown,
  chatId: string,
  updatedAt: string,
  getState?: () => unknown,
): void {
  const sortByUpdatedAtDesc = (draft: ServerChat[]) => {
    draft.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  };
  const patch = (draft: ServerChat[]) => {
    const idx = draft.findIndex((c) => c.id === chatId);
    if (idx < 0) return;
    const current = Date.parse(draft[idx].updatedAt);
    const requested = Date.parse(updatedAt);
    const max = draft.reduce((newest, chat) => {
      const ms = Date.parse(chat.updatedAt);
      return Number.isFinite(ms) ? Math.max(newest, ms) : newest;
    }, Number.NEGATIVE_INFINITY);
    if (Number.isFinite(current) && current >= max && (!Number.isFinite(requested) || current >= requested)) return;
    const next = Number.isFinite(requested) ? Math.max(requested, max + 1) : max + 1;
    const nextUpdatedAt = Number.isFinite(next) ? new Date(next).toISOString() : updatedAt;
    draft[idx] = { ...draft[idx], updatedAt: nextUpdatedAt };
    sortByUpdatedAtDesc(draft);
  };
  const patchSingle = (draft: ServerChat) => {
    if (draft.id !== chatId) return;
    const current = Date.parse(draft.updatedAt);
    const next = Date.parse(updatedAt);
    if (Number.isFinite(current) && Number.isFinite(next) && current > next) return;
    draft.updatedAt = updatedAt;
  };

  dispatch(api.util.updateQueryData("getChats", undefined, patch));
  dispatch(api.util.updateQueryData("getChat", chatId, patchSingle));

  if (!getState) return;
  const state = getState() as Record<string, unknown>;
  const apiState = state[api.reducerPath] as { queries?: Record<string, { data?: ServerChat[] }> } | undefined;
  if (!apiState?.queries) return;
  for (const [key, entry] of Object.entries(apiState.queries)) {
    if (!key.startsWith("getChats(")) continue;
    const chats = entry?.data;
    if (!Array.isArray(chats)) continue;
    const chat = chats.find((c: ServerChat) => c.id === chatId);
    if (!chat) continue;
    dispatch(
      api.util.updateQueryData("getChats", { workspaceId: chat.workspaceId }, patch),
    );
  }
}

function patchChatFailedInCache(
  dispatch: (a: unknown) => unknown,
  chatId: string,
  failed: boolean,
  getState?: () => unknown,
): void {
  const patchList = (draft: ServerChat[]) => {
    const chat = draft.find((c) => c.id === chatId);
    if (chat) chat.failed = failed;
  };
  const patchSingle = (draft: ServerChat) => {
    if (draft.id === chatId) draft.failed = failed;
  };

  dispatch(api.util.updateQueryData("getChats", undefined, patchList));
  dispatch(api.util.updateQueryData("getChat", chatId, patchSingle));

  if (!getState) return;
  const state = getState() as Record<string, unknown>;
  const apiState = state[api.reducerPath] as { queries?: Record<string, { data?: ServerChat[] }> } | undefined;
  if (!apiState?.queries) return;
  for (const [key, entry] of Object.entries(apiState.queries)) {
    if (!key.startsWith("getChats(")) continue;
    const chats = entry?.data;
    if (!Array.isArray(chats)) continue;
    const chat = chats.find((c: ServerChat) => c.id === chatId);
    if (!chat) continue;
    dispatch(
      api.util.updateQueryData("getChats", { workspaceId: chat.workspaceId }, patchList),
    );
  }
}

function messageMatchesFilter(msg: ServerMessage, filter: MessagesFilter, workspaceId?: string): boolean {
  if (filter.chatId && filter.chatId !== msg.chatId) return false;
  if (filter.workspaceId && workspaceId && filter.workspaceId !== workspaceId) return false;
  if (filter.workspaceId && !workspaceId) return false;
  if (filter.kind?.length && !filter.kind.includes(msg.kind ?? "chat")) return false;
  if (filter.parentId && filter.parentId !== msg.parentId) return false;
  if (filter.state?.length && !filter.state.includes(msg.state ?? "pending")) return false;
  if (filter.contentKind?.length && !filter.contentKind.includes(msg.content.type)) return false;
  if (filter.scheduled !== undefined) {
    const scheduled = !!msg.executeAt || !!msg.cron;
    if (filter.scheduled !== scheduled) return false;
  }
  return true;
}

function patchCrossMessageCaches(
  dispatch: (a: unknown) => unknown,
  getState: () => unknown,
  msg: ServerMessage,
  mode: "appended" | "updated",
  workspaceId?: string,
): void {
  const state = getState() as Record<string, unknown>;
  const apiState = state[api.reducerPath] as { queries?: Record<string, { data?: ListMessagesResponse }> } | undefined;
  if (!apiState?.queries) return;

  for (const [key, entry] of Object.entries(apiState.queries)) {
    if (!key.startsWith("getMessages(")) continue;
    if (!entry?.data?.items) continue;
    const argJson = key.slice("getMessages(".length, -1);
    let filter: MessagesFilter;
    try {
      filter = JSON.parse(argJson) as MessagesFilter;
    } catch {
      continue;
    }

    const alreadyPresent = entry.data.items.some((m) => m.id === msg.id);
    if (!alreadyPresent && (mode === "updated" || !messageMatchesFilter(msg, filter, workspaceId))) continue;

    dispatch(
      api.util.updateQueryData("getMessages", filter, (draft) => {
        const idx = draft.items.findIndex((m) => m.id === msg.id);
        if (idx >= 0) draft.items[idx] = msg;
        else draft.items.unshift(msg);
      }),
    );
  }
}

function patchPerChatMessageCaches(
  dispatch: (a: unknown) => unknown,
  chatId: string,
  patch: (draft: ListMessagesResponse) => void,
): void {
  dispatch(api.util.updateQueryData("getChatMessages", { chatId, full: false }, patch));
  dispatch(api.util.updateQueryData("getChatMessages", { chatId, full: true }, patch));
}

export function logEntryFromWsPayload(payload: WsEvent & { type: "message.log_appended" }): AgentLogEntry {
  const { kind, line } = payload.payload;
  if (kind === "stderr") return { kind: "stderr", line };
  if (kind === "event") return { kind: "event", event: JSON.parse(line) };
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
      return { kind: "event", event: parsed as AgentEvent };
    }
  } catch {
    // Raw stdout from fake/plain drivers is still useful as a live diagnostic.
  }
  return { kind: "unparsed", line };
}

function patchProgressLogCaches(
  dispatch: (a: unknown) => unknown,
  getState: () => unknown,
  event: WsEvent & { type: "message.log_appended" },
): boolean {
  let entry: AgentLogEntry;
  try {
    entry = logEntryFromWsPayload(event);
  } catch {
    entry = { kind: "unparsed", line: event.payload.line };
  }

  const messageId = event.payload.messageId;
  const state = getState() as Record<string, unknown>;
  const apiState = state[api.reducerPath] as { queries?: Record<string, { endpointName?: string; data?: ListMessagesResponse; originalArgs?: { chatId?: string; full?: boolean; before?: string } }> } | undefined;
  if (!apiState?.queries) return false;

  let patched = false;
  for (const [key, cacheEntry] of Object.entries(apiState.queries)) {
    if (cacheEntry.endpointName && cacheEntry.endpointName !== "getChatMessages") continue;
    const cachedMsg = cacheEntry?.data?.items?.find((m) => m.id === messageId);
    if (!cachedMsg) continue;
    // getChatMessages uses a custom serialized cache key (`chatId:timeline` /
    // `chatId:full`), so the RTK query key is not JSON-parseable. Use the
    // stored original args when present, and fall back to the message chat id +
    // serialized key suffix. Without this, live progress stays pending until a
    // later message.updated merges it, which makes tool calls appear only with
    // the final assistant message.
    const originalArgs = cacheEntry.originalArgs;
    const chatId = originalArgs?.chatId ?? cachedMsg.chatId;
    const full = originalArgs?.full ?? key.includes(":full");
    const args: { chatId: string; full?: boolean; before?: string } = { chatId, full };
    dispatch(api.util.updateQueryData("getChatMessages", args, (draft) => {
      const msg = draft.items.find((m) => m.id === messageId);
      if (!msg) return;
      msg.progressLog = [...(msg.progressLog ?? []), entry];
      patched = true;
    }));
  }
  if (!patched) {
    pendingProgressLogByMessageId.set(messageId, [
      ...(pendingProgressLogByMessageId.get(messageId) ?? []),
      entry,
    ]);
  }
  return patched;
}

function mergePendingProgressIntoChatMessageCaches(
  dispatch: (a: unknown) => unknown,
  getState: () => unknown,
): void {
  if (pendingProgressLogByMessageId.size === 0) return;
  const state = getState() as Record<string, unknown>;
  const apiState = state[api.reducerPath] as { queries?: Record<string, { endpointName?: string; data?: ListMessagesResponse; originalArgs?: { chatId?: string; full?: boolean; before?: string } }> } | undefined;
  if (!apiState?.queries) return;

  for (const [key, cacheEntry] of Object.entries(apiState.queries)) {
    if (cacheEntry.endpointName && cacheEntry.endpointName !== "getChatMessages") continue;
    const items = cacheEntry.data?.items;
    if (!items?.length) continue;

    const messageIdsWithPending = items
      .map((m) => m.id)
      .filter((id) => pendingProgressLogByMessageId.has(id));
    if (messageIdsWithPending.length === 0) continue;

    const originalArgs = cacheEntry.originalArgs;
    const chatId = originalArgs?.chatId ?? items[0]?.chatId;
    if (!chatId) continue;
    const full = originalArgs?.full ?? key.includes(":full");
    const args: { chatId: string; full?: boolean; before?: string } = { chatId, full };

    dispatch(api.util.updateQueryData("getChatMessages", args, (draft) => {
      for (const msg of draft.items) {
        const pending = pendingProgressLogByMessageId.get(msg.id);
        if (!pending?.length) continue;
        msg.progressLog = [...(msg.progressLog ?? []), ...pending];
        pendingProgressLogByMessageId.delete(msg.id);
      }
    }));
  }
}

/**
 * Clears unread on the server and patches the RTK Query cache in one
 * step, without going through RTK Query's mutation (which would
 * invalidate Chat tags and trigger a refetch that races with the
 * mark-as-read effect).
 *
 * The server emits a `chat.updated` WS event after the PATCH, which the
 * middleware handles normally to confirm the cache state.
 */
export function markChatReadQuietly(
  chatId: string,
  dispatch?: (a: unknown) => unknown,
  getState?: () => unknown,
): void {
  if (dispatch) {
    patchChatUnreadInCache(dispatch, chatId, getState);
  }
  const token = getSessionToken();
  if (!token) return;
  fetch(`/api/chats/${chatId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ unread: false }),
  }).catch(() => { /* best-effort */ });
}

/**
 * Actions observed by the WS middleware. Consumers dispatch `wsConnect()`
 * after boot; the middleware manages a single socket, auto-reconnects
 * with exponential backoff, and translates inbound events into RTK Query
 * cache updates so components react to server-pushed state.
 *
 * Scaffolded in slice-0; enabled by slice 12.
 */
export const wsConnect = createAction("ws/connect");
export const wsDisconnect = createAction("ws/disconnect");
export const wsEvent = createAction<WsEvent>("ws/event");

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;

export const wsMiddleware: Middleware = (storeApi) => {
  let socket: WebSocket | null = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let shouldReconnect = false;
  let hasConnectedOnce = false;

  const wsUrl = (): string => {
    const token = getSessionToken();
    if (!token) return "";
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}`;
  };

  const open = (): void => {
    const url = wsUrl();
    if (!url) return;

    const ws = new WebSocket(url);
    socket = ws;

    ws.addEventListener("open", () => {
      reconnectDelay = RECONNECT_MIN_MS;
      // Clear the WS-known guard so the upcoming getChats refetch is
      // fully authoritative. On reconnect, any WS events missed during
      // the disconnect gap can't be corrected from wsKnownChatIds —
      // only a fresh server snapshot can fix stale running state.
      storeApi.dispatch(clearWsKnownChatIds());
      // On reconnect (not the initial connect), refetch the chat list so
      // the `running` boolean reflects post-recovery state. Orphaned runs
      // that completed during the disconnect gap are corrected here.
      // Skipping this on initial connect avoids a race where the refetch
      // returns running=false after the fast fake driver has already
      // completed, causing the sidebar spinner to never appear.
      if (hasConnectedOnce) {
        storeApi.dispatch(api.util.invalidateTags([{ type: "Chat", id: "LIST" }]));
      }
      hasConnectedOnce = true;
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      try {
        const event = JSON.parse(String(ev.data)) as WsEvent;
        storeApi.dispatch(wsEvent(event));
        const state = storeApi.getState() as RootState;
        applyEventToCache(storeApi.dispatch as (a: unknown) => unknown, event, state?.derived?.viewingChatId ?? null, storeApi.getState as () => unknown);
      } catch {
        /* malformed — drop */
      }
    });

    ws.addEventListener("close", (ev: CloseEvent) => {
      socket = null;
      if (ev.code === 1008 || ev.code === 4401) {
        // server rejected token — force relogin
        try {
          sessionStorage.removeItem("desk.session.token");
        } catch {
          /* ignore */
        }
        window.location.reload();
        return;
      }
      if (shouldReconnect) scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  };

  const scheduleReconnect = (): void => {
    if (reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  };

  const closeSocket = (): void => {
    shouldReconnect = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }
    socket = null;
  };

  return (next) => (action) => {
    if (wsConnect.match(action)) {
      shouldReconnect = true;
      if (!socket) open();
    } else if (wsDisconnect.match(action)) {
      closeSocket();
    }
    const result = next(action);
    // After any getChats query fulfils (initial load, refetch from tag
    // invalidation, or polling), suppress unread for the chat the user is
    // currently viewing. Without this, a Chat LIST refetch triggered by a
    // *different* chat's message would overwrite our optimistic
    // unread=false patch with the server's stale unread=1 value.
    //
    // We also fire markChatReadQuietly to reconcile the server: the DB
    // may still hold unread=1 from a messages.insert that raced with our
    // earlier PATCH. Without this server-side reconciliation, every future
    // getChats refetch would keep returning unread=true and the handler
    // would keep patching it away — a silent retry loop that becomes
    // visible as a dot flash whenever React renders between the refetch
    // and the patch.
    if (api.endpoints.getChats.matchFulfilled(action)) {
      const state = storeApi.getState() as RootState;
      const viewingId = state.derived.viewingChatId;
      if (viewingId) {
        const args = action.meta.arg.originalArgs as { workspaceId?: string } | undefined;
        // Read unread state from the payload (the fresh server response) rather
        // than from inside an Immer callback — avoids mutation-in-closure.
        const payload = action.payload as ServerChat[];
        const viewedInPayload = payload.find((c) => c.id === viewingId);
        if (viewedInPayload?.unread) {
          (storeApi.dispatch as (a: unknown) => unknown)(
            api.util.updateQueryData("getChats", args, (draft) => {
              const c = draft.find((x) => x.id === viewingId);
              if (c) c.unread = false;
            }),
          );
          markChatReadQuietly(viewingId, storeApi.dispatch as (a: unknown) => unknown, storeApi.getState as () => unknown);
        }
      }
    }
    if (api.endpoints.getChatMessages.matchFulfilled(action)) {
      mergePendingProgressIntoChatMessageCaches(
        storeApi.dispatch as (a: unknown) => unknown,
        storeApi.getState as () => unknown,
      );
    }
    return result;
  };
};

export function applyEventToCache(
  dispatch: (a: unknown) => unknown,
  event: WsEvent,
  viewingChatId?: string | null,
  getState?: () => unknown,
): void {
  switch (event.type) {
    case "chat.updated": {
      const chat = event.payload;
      // Never flip the viewed chat to unread — the user is reading it.
      // The server may set unread=1 (messages.insert for non-internal
      // messages does this unconditionally) but we suppress it client-side
      // and fire a quiet markRead to reconcile the server state.
      const isViewedAndUnread = viewingChatId === chat.id && chat.unread;
      if (isViewedAndUnread) {
        markChatReadQuietly(chat.id, dispatch, getState);
      }
      const chatForCache = isViewedAndUnread
        ? { ...chat, unread: false }
        : chat;
      dispatch(
        api.util.updateQueryData(
          "getChats",
          { workspaceId: chatForCache.workspaceId },
          (draft) => {
            const idx = draft.findIndex((c) => c.id === chatForCache.id);
            if (idx >= 0) {
              // `chat.updated` carries the base chat row from GET/PATCH
              // /chats/:id. Preserve list-only fields that are hydrated by
              // GET /chats so a metadata/unread patch does not drop the
              // sidebar icon or running spinner until the next list refetch.
              draft[idx] = {
                ...chatForCache,
                kind: draft[idx].kind,
                running: draft[idx].running,
                failed: draft[idx].failed,
              };
            } else {
              draft.unshift({ ...chatForCache, kind: "chat", running: false, failed: false });
            }
          },
        ),
      );
      // Also patch the unscoped list for components that render global chats.
      dispatch(
        api.util.updateQueryData("getChats", undefined, (draft) => {
          const idx = draft.findIndex((c) => c.id === chatForCache.id);
          if (idx >= 0) {
            draft[idx] = {
              ...chatForCache,
              kind: draft[idx].kind,
              running: draft[idx].running,
              failed: draft[idx].failed,
            };
          }
        }),
      );
      dispatch(
        api.util.updateQueryData("getChat", chatForCache.id, () => chatForCache),
      );
      break;
    }
    case "chat.deleted": {
      const { chatId, workspaceId } = event.payload;
      dispatch(
        api.util.updateQueryData(
          "getChats",
          { workspaceId },
          (draft) => draft.filter((c) => c.id !== chatId),
        ),
      );
      dispatch(
        api.util.updateQueryData("getChats", undefined, (draft) =>
          draft.filter((c) => c.id !== chatId),
        ),
      );
      // Clean up running-chat tracking so deleted chats don't leave
      // orphaned spinner entries.
      dispatch(markChatIdle(chatId));
      break;
    }
    case "message.appended":
    case "message.updated": {
      const rawMsg: ServerMessage = event.payload;
      const msg = mergeProgressLog(rawMsg);
      const timelineMsg = compactTimelineMessage(msg);
      dispatch(api.util.updateQueryData("getChatMessages", { chatId: msg.chatId, full: false }, (draft) => {
        const idx = draft.items.findIndex((m) => m.id === msg.id);
        const existingProgress = idx >= 0 ? draft.items[idx]?.progressLog : undefined;
        const nextTimelineMsg = timelineMsg ? mergeProgressLog(timelineMsg, existingProgress) : null;
        if (!timelineMsg) {
          if (idx >= 0) draft.items.splice(idx, 1);
        } else if (idx >= 0) draft.items[idx] = nextTimelineMsg!;
        else draft.items.push(nextTimelineMsg!);
      }));
      dispatch(api.util.updateQueryData("getChatMessages", { chatId: msg.chatId, full: true }, (draft) => {
        const idx = draft.items.findIndex((m) => m.id === msg.id);
        const nextMsg = mergeProgressLog(msg, idx >= 0 ? draft.items[idx]?.progressLog : undefined);
        if (idx >= 0) draft.items[idx] = nextMsg;
        else draft.items.push(nextMsg);
      }));
      if (getState) {
        patchCrossMessageCaches(
          dispatch,
          getState,
          msg,
          event.type === "message.appended" ? "appended" : "updated",
          "workspaceId" in event ? event.workspaceId : undefined,
        );
      }
      dispatch(api.util.invalidateTags([{ type: "Message", id: "CROSS" }]));
      // Track running chats for the sidebar spinner.
      if (msg.content?.type === "agent_turn") {
        if (msg.state === "pending" || msg.state === "running") {
          dispatch(markChatRunning(msg.chatId));
          patchChatFailedInCache(dispatch, msg.chatId, false, getState);
        } else if (msg.state === "failed") {
          dispatch(markChatFailed(msg.chatId));
          patchChatFailedInCache(dispatch, msg.chatId, true, getState);
        } else {
          dispatch(markChatIdle(msg.chatId));
          dispatch(clearChatFailed(msg.chatId));
          patchChatFailedInCache(dispatch, msg.chatId, false, getState);
        }
      }
      // Non-internal messages update chat.unread and chat.updated_at on
      // the server. Internal messages (summary, summary_request, agent_turn,
      // and any message with kind="summary") leave the chat row untouched, so
      // skip the invalidation. Artifact refs are visible agent messages, so
      // they should still bump chat activity.
      //
      // For the currently-viewed chat, skip the cache invalidation: the
      // user is already reading, so flipping unread=true in the cache
      // would flash the sidebar dot. But the server *did* set unread=1
      // in the DB, so we need to clear it — otherwise the stale flag
      // leaks out on the next refetch. markChatReadQuietly fires a raw
      // PATCH that clears unread on the server without triggering RTK
      // Query tag invalidation, avoiding the flash entirely.
      if (event.type === "message.appended") {
        const isInternal = isInternalChatMessage(msg);
        if (!isInternal) {
          dispatch(clearChatFailed(msg.chatId));
          patchChatFailedInCache(dispatch, msg.chatId, false, getState);
          patchChatActivityInCache(dispatch, msg.chatId, msg.createdAt, getState);
          const isViewedChat = viewingChatId === msg.chatId;
          if (isViewedChat) {
            markChatReadQuietly(msg.chatId, dispatch, getState);
          } else {
            // Notification routing relies on the event carrying workspace
            // context (chats.ts populates these on every chat-message emit).
            // If a future emitter forgets to include workspaceId, the
            // notification simply won't show — no silent fallback that
            // depends on cache shape.
            const userId = (getState?.() as RootState | undefined)
              ? selectCurrentUserId(getState!() as RootState)
              : null;
            maybeShowChatBrowserNotification(
              msg,
              viewingChatId,
              event.workspaceId,
              event.chatTitle,
              userId,
              event.actorUserId,
            );
            dispatch(
              api.util.invalidateTags([
                { type: "Chat", id: msg.chatId },
                { type: "Chat", id: "LIST" },
              ]),
            );
          }
        }
      }
      break;
    }
    case "message.streaming": {
      const { chatId, messageId, delta } = event.payload;
      // Streaming output is live proof the agent is working. Prefer the
      // sidebar spinner over any stale failed flag from an earlier turn.
      dispatch(markChatRunning(chatId));
      patchChatFailedInCache(dispatch, chatId, false, getState);
      patchPerChatMessageCaches(dispatch, chatId, (draft) => {
        const m = draft.items.find((x) => x.id === messageId);
        if (m && m.content.type === "text") {
          m.content = {
            ...m.content,
            text: (m.content.text ?? "") + delta,
          };
        }
      });
      break;
    }
    case "artifact.created": {
      // Invalidate affected lists — chat artifacts and library both care.
      dispatch(api.util.invalidateTags([{ type: "LibraryFile", id: "LIST" }]));
      dispatch(
        api.util.invalidateTags([
          { type: "ChatArtifact", id: `CHAT_${event.payload.path.split("/")[2] ?? ""}` },
        ]),
      );
      // Feed the derivedSlice so Desk can render "1 update" pills.
      dispatch(
        pushArtifactUpdate({
          id: `upd-${event.payload.path}-${event.payload.createdAt}`,
          artifactId: event.payload.path,
          message: `New artifact: ${event.payload.name}`,
          timestamp: new Date(event.payload.createdAt).getTime(),
        }),
      );
      break;
    }
    case "library.changed": {
      dispatch(api.util.invalidateTags([{ type: "LibraryFile", id: "LIST" }]));
      dispatch(bumpFileChangeCounter(event.payload.path));
      // Renames retarget chat-attachment symlinks (Files panel) and
      // rewrite message-attachment paths (chat bubbles). The server
      // tells us which chats were touched so we only refetch those.
      // Per-chat ChatArtifact tags need exact-match invalidation —
      // RTK Query's type-only invalidation wouldn't reach `CHAT_<id>`.
      for (const chatId of event.payload.affectedChatIds ?? []) {
        dispatch(
          api.util.invalidateTags([{ type: "ChatArtifact", id: `CHAT_${chatId}` }]),
        );
      }
      break;
    }
    case "workspace.synced": {
      dispatch(bumpWorkspaceChangeCounter(event.payload.workspaceId));
      break;
    }
    case "message.log_appended": {
      if (getState) patchProgressLogCaches(dispatch, getState, event);
      break;
    }
  }
}
