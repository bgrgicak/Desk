import type { Middleware } from "@reduxjs/toolkit";
import { createAction } from "@reduxjs/toolkit";
import { api } from "../api";
import { pushArtifactUpdate, bumpFileChangeCounter, bumpWorkspaceChangeCounter, markChatRunning, markChatIdle, clearWsKnownChatIds } from "../slices/derivedSlice";
import type { RootState } from "../store";
import { getSessionToken } from "@/auth/session";
import type { ServerChat, ServerMessage, WsEvent } from "../types";

/**
 * Optimistic cache patcher: sets `unread: false` for a chat in every
 * `getChats` cache entry (both the unscoped and any workspace-scoped
 * variants).
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
  // Always try the unscoped cache (cheap no-op when it doesn't exist).
  dispatch(api.util.updateQueryData("getChats", undefined, patch));

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
            if (idx >= 0) draft[idx] = chatForCache;
            else draft.unshift(chatForCache);
          },
        ),
      );
      // Also patch the unscoped list for components that render global chats.
      dispatch(
        api.util.updateQueryData("getChats", undefined, (draft) => {
          const idx = draft.findIndex((c) => c.id === chatForCache.id);
          if (idx >= 0) draft[idx] = chatForCache;
        }),
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
      const msg: ServerMessage = event.payload;
      dispatch(
        api.util.updateQueryData(
          "getChatMessages",
          { chatId: msg.chatId },
          (draft) => {
            const idx = draft.items.findIndex((m) => m.id === msg.id);
            if (idx >= 0) draft.items[idx] = msg;
            else draft.items.push(msg);
          },
        ),
      );
      dispatch(api.util.invalidateTags([{ type: "Message", id: "CROSS" }]));
      // Track running chats for the sidebar spinner.
      if (msg.content?.type === "agent_turn") {
        if (msg.state === "pending" || msg.state === "running") {
          dispatch(markChatRunning(msg.chatId));
        } else {
          dispatch(markChatIdle(msg.chatId));
        }
      }
      // Non-internal messages update chat.unread and chat.updated_at on
      // the server. Internal messages (summary, summary_request, agent_turn,
      // artifactRef, and any message with kind="summary") leave the chat
      // row untouched, so skip the invalidation.
      //
      // For the currently-viewed chat, skip the cache invalidation: the
      // user is already reading, so flipping unread=true in the cache
      // would flash the sidebar dot. But the server *did* set unread=1
      // in the DB, so we need to clear it — otherwise the stale flag
      // leaks out on the next refetch. markChatReadQuietly fires a raw
      // PATCH that clears unread on the server without triggering RTK
      // Query tag invalidation, avoiding the flash entirely.
      if (event.type === "message.appended") {
        const ct = msg.content?.type;
        const mk = (msg as { kind?: string }).kind ?? "chat";
        const isInternal =
          ct === "agent_turn" ||
          ct === "summary_request" ||
          ct === "summary" ||
          ct === "artifactRef" ||
          mk === "summary";
        if (!isInternal) {
          const isViewedChat = viewingChatId === msg.chatId;
          if (isViewedChat) {
            markChatReadQuietly(msg.chatId, dispatch, getState);
          } else {
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
      dispatch(
        api.util.updateQueryData(
          "getChatMessages",
          { chatId },
          (draft) => {
            const m = draft.items.find((x) => x.id === messageId);
            if (m && m.content.type === "text") {
              m.content = {
                ...m.content,
                text: (m.content.text ?? "") + delta,
              };
            }
          },
        ),
      );
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
          timestamp: new Date(event.payload.createdAt),
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
      // TODO(slice 12): forward to log viewer when runs log UI exists.
      break;
    }
  }
}
