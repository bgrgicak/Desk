import type { Middleware } from "@reduxjs/toolkit";
import { createAction } from "@reduxjs/toolkit";
import { api } from "../api";
import { pushArtifactUpdate, bumpFileChangeCounter, bumpWorkspaceChangeCounter, markChatRunning, markChatIdle } from "../slices/derivedSlice";
import { getSessionToken } from "@/auth/session";
import type { ServerMessage, WsEvent } from "../types";

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
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      try {
        const event = JSON.parse(String(ev.data)) as WsEvent;
        storeApi.dispatch(wsEvent(event));
        applyEventToCache(storeApi.dispatch as (a: unknown) => unknown, event);
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
    return next(action);
  };
};

export function applyEventToCache(
  dispatch: (a: unknown) => unknown,
  event: WsEvent,
): void {
  switch (event.type) {
    case "chat.updated": {
      const chat = event.payload;
      dispatch(
        api.util.updateQueryData(
          "getChats",
          { workspaceId: chat.workspaceId },
          (draft) => {
            const idx = draft.findIndex((c) => c.id === chat.id);
            if (idx >= 0) draft[idx] = chat;
            else draft.unshift(chat);
          },
        ),
      );
      // Also patch the unscoped list for components that render global chats.
      dispatch(
        api.util.updateQueryData("getChats", undefined, (draft) => {
          const idx = draft.findIndex((c) => c.id === chat.id);
          if (idx >= 0) draft[idx] = chat;
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
      // the server. Invalidate the chat list so the sidebar picks up the
      // new state. Internal messages (summary, summary_request, agent_turn)
      // leave the chat row untouched, so skip the invalidation to avoid a
      // redundant refetch.
      if (event.type === "message.appended") {
        const ct = msg.content?.type;
        const isInternal =
          ct === "agent_turn" || ct === "summary_request" || ct === "summary";
        if (!isInternal) {
          dispatch(
            api.util.invalidateTags([
              { type: "Chat", id: msg.chatId },
              { type: "Chat", id: "LIST" },
            ]),
          );
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
