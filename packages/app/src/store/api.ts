import {
  createApi,
  fetchBaseQuery,
  type BaseQueryFn,
} from "@reduxjs/toolkit/query/react";
import { getSessionToken } from "@/auth/session";
import type {
  AttachmentRef,
  ListLibraryResponse,
  ListMessagesResponse,
  MessagesFilter,
  ServerAgent,
  ServerChat,
  ServerFile,
  ServerMessage,
  ServerUser,
  ServerWorkspace,
  ServerWorkspaceAgent,
} from "./types";

const rawBaseQuery = fetchBaseQuery({
  baseUrl: "/api",
  prepareHeaders: (headers) => {
    const token = getSessionToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    // Self-healing: server upserts users.timezone when this drifts.
    // Resolved per-request so a user moving between zones is captured
    // without a re-login. Wrapped in try/catch because Intl is unavailable
    // in some test environments.
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) headers.set("X-Client-Timezone", tz);
    } catch {
      /* ignore */
    }
    return headers;
  },
});

const RETRY_STATUSES = new Set([502, 503]);
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 600;

/**
 * If an authed call returns 401 the stored token is dead. Clear it and
 * reload so the App outer-render check sees no token and renders the
 * LoginScreen — without a reload the React tree stays wedged on the stale
 * token (the check runs once at mount and doesn't subscribe to
 * sessionStorage). The one-shot guard keeps a 401-storm from looping
 * the page.
 *
 * 502/503 responses indicate the backend is restarting (e.g. tsx hot-reload).
 * Retry up to RETRY_ATTEMPTS times so in-flight requests survive a restart
 * rather than silently failing.
 */
let reloadingFor401 = false;
const baseQuery: BaseQueryFn<
  Parameters<typeof rawBaseQuery>[0],
  unknown,
  unknown
> = async (args, api, extra) => {
  let result = await rawBaseQuery(args, api, extra);

  // Only retry safe (idempotent read) methods. Retrying a POST/PUT/DELETE
  // after a 502 could duplicate a mutation that the server already processed
  // before crashing.
  const method = (typeof args === "string" ? "GET" : (args as { method?: string }).method ?? "GET").toUpperCase();
  const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);

  let attempts = 0;
  while (
    isSafeMethod &&
    attempts < RETRY_ATTEMPTS &&
    result.error &&
    typeof result.error === "object" &&
    "status" in result.error &&
    typeof result.error.status === "number" &&
    RETRY_STATUSES.has(result.error.status)
  ) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempts + 1)));
    result = await rawBaseQuery(args, api, extra);
    attempts++;
  }

  if (
    result.error &&
    typeof result.error === "object" &&
    "status" in result.error &&
    result.error.status === 401
  ) {
    try {
      sessionStorage.removeItem("desk.session.token");
    } catch {
      /* ignore */
    }
    if (!reloadingFor401 && typeof window !== "undefined") {
      reloadingFor401 = true;
      window.location.reload();
    }
  }
  return result;
};

function buildMessagesQuery(f: MessagesFilter): string {
  const params = new URLSearchParams();
  if (!f.full) params.set("view", "compact");
  if (f.workspaceId) params.set("workspaceId", f.workspaceId);
  if (f.chatId) params.set("chatId", f.chatId);
  if (f.state && f.state.length > 0) params.set("state", f.state.join(","));
  if (f.scheduled !== undefined)
    params.set("scheduled", String(f.scheduled));
  if (f.awaitingUser !== undefined)
    params.set("awaitingUser", String(f.awaitingUser));
  if (f.contentKind && f.contentKind.length > 0)
    params.set("contentKind", f.contentKind.join(","));
  if (f.kind && f.kind.length > 0) params.set("kind", f.kind.join(","));
  if (f.parentId) params.set("parentId", f.parentId);
  if (f.since) params.set("since", f.since);
  if (f.limit !== undefined) params.set("limit", String(f.limit));
  if (f.cursor) params.set("cursor", f.cursor);
  const qs = params.toString();
  return qs ? `/messages?${qs}` : "/messages";
}

function updateLiveMessageCaches(
  dispatch: (action: unknown) => unknown,
  getState: () => unknown,
  target: { chatId: string; messageId: string },
  patch: (message: ServerMessage) => void,
): Array<{ undo(): void }> {
  const patchList = (draft: ListMessagesResponse) => {
    const msg = draft.items.find((m) => m.id === target.messageId && m.chatId === target.chatId);
    if (msg) patch(msg);
  };
  const undos: Array<{ undo(): void }> = [];
  undos.push(dispatch(api.util.updateQueryData("getChatMessages", { chatId: target.chatId, full: false }, patchList)) as { undo(): void });
  undos.push(dispatch(api.util.updateQueryData("getChatMessages", { chatId: target.chatId, full: true }, patchList)) as { undo(): void });

  const state = getState() as Record<string, unknown>;
  const apiState = state[api.reducerPath] as { queries?: Record<string, { data?: ListMessagesResponse }> } | undefined;
  if (!apiState?.queries) return undos;
  for (const [key, entry] of Object.entries(apiState.queries)) {
    if (!key.startsWith("getMessages(")) continue;
    if (!entry?.data?.items?.some((m) => m.id === target.messageId && m.chatId === target.chatId)) continue;
    const argJson = key.slice("getMessages(".length, -1);
    try {
      undos.push(dispatch(api.util.updateQueryData("getMessages", JSON.parse(argJson) as MessagesFilter, patchList)) as { undo(): void });
    } catch {
      // Cache keys are generated by RTK Query; if that changes, skipping one
      // optimistic patch is safer than failing the mutation path.
    }
  }
  return undos;
}

export interface SearchResult {
  type: "file" | "chat" | "message";
  id: string;
  title: string;
  snippet?: string;
  workspaceId?: string;
  workspaceSlug?: string;
  messageId?: string;
  kind?: "chat" | "message" | "summary" | "library_file" | "attachment" | "artifact";
  score?: number;
}

export interface ModelRef {
  provider: string;
  id: string;
  label?: string;
}

export const api = createApi({
  reducerPath: "api",
  baseQuery,
  tagTypes: [
    "Me",
    "Workspace",
    "WorkspaceAgents",
    "Chat",
    "Message",
    "Agent",
    "LibraryFile",
    "ChatArtifact",
    "ProviderKeys",
    "ProvidersMeta",
    "LocalSources",
    "Models",
  ],
  endpoints: (build) => ({
    // ── Me ────────────────────────────────────────────────────────────
    getMe: build.query<ServerUser, void>({
      query: () => "/me",
      providesTags: ["Me"],
    }),
    patchMe: build.mutation<
      ServerUser,
      Partial<Pick<ServerUser, "username" | "email" | "avatarPath">>
    >({
      query: (body) => ({ url: "/me", method: "PATCH", body }),
      invalidatesTags: ["Me"],
    }),
    changePassword: build.mutation<
      { ok: true },
      { currentPassword: string; newPassword: string }
    >({
      query: (body) => ({ url: "/me/password", method: "POST", body }),
    }),
    getProviderKeys: build.query<
      Record<string, string | null>,
      void
    >({
      query: () => "/me/providers",
      transformResponse: (r: { providers: Record<string, string | null> }) =>
        r.providers,
      providesTags: ["ProviderKeys"],
    }),
    putProviderKeys: build.mutation<
      Record<string, string | null>,
      Record<string, string | null>
    >({
      query: (providers) => ({
        url: "/me/providers",
        method: "PUT",
        body: { providers },
      }),
      transformResponse: (r: { providers: Record<string, string | null> }) =>
        r.providers,
      invalidatesTags: ["ProviderKeys", "Models"],
    }),
    getProvidersMeta: build.query<
      Record<string, { name?: string; enabled?: boolean }>,
      void
    >({
      query: () => "/me/providers/meta",
      transformResponse: (r: { meta: Record<string, { name?: string; enabled?: boolean }> }) =>
        r.meta,
      providesTags: ["ProvidersMeta"],
    }),
    putProvidersMeta: build.mutation<
      Record<string, { name?: string; enabled?: boolean }>,
      Record<string, { name?: string; enabled?: boolean } | null>
    >({
      query: (meta) => ({
        url: "/me/providers/meta",
        method: "PUT",
        body: { meta },
      }),
      transformResponse: (r: { meta: Record<string, { name?: string; enabled?: boolean }> }) =>
        r.meta,
      // Disabling a provider also has to retire it from the model picker
      // and any cached sandbox model lists, so invalidate Models too.
      invalidatesTags: ["ProvidersMeta", "Models"],
    }),
    /**
     * Lists every host-detected local source (Codex today; LM Studio /
     * Ollama in the future), with the user's per-source opt-in flag.
     */
    getLocalSources: build.query<
      {
        sources: Array<{
          kind: string
          available: boolean
          enabled: boolean
          reason?: string
          detail?: Record<string, string | number | boolean>
        }>
      },
      void
    >({
      query: () => "/me/providers/local",
      providesTags: ["LocalSources"],
    }),
    /** Toggles the per-user opt-in for a single local source. */
    putLocalSource: build.mutation<
      {
        kind: string
        available: boolean
        enabled: boolean
        reason?: string
        detail?: Record<string, string | number | boolean>
      },
      { kind: string; enabled: boolean }
    >({
      query: ({ kind, enabled }) => ({
        url: `/me/providers/local/${encodeURIComponent(kind)}`,
        method: "PUT",
        body: { enabled },
      }),
      invalidatesTags: ["LocalSources", "Models"],
    }),

    // ── Workspaces ────────────────────────────────────────────────────
    getWorkspaces: build.query<ServerWorkspace[], void>({
      query: () => "/workspaces",
      keepUnusedDataFor: 30 * 60,
      providesTags: (result) =>
        result
          ? [
              ...result.map((w) => ({ type: "Workspace" as const, id: w.id })),
              { type: "Workspace" as const, id: "LIST" },
            ]
          : [{ type: "Workspace", id: "LIST" }],
    }),
    createWorkspace: build.mutation<
      ServerWorkspace,
      { name: string; description?: string; icon?: string; color?: string }
    >({
      query: (body) => ({ url: "/workspaces", method: "POST", body }),
      invalidatesTags: [{ type: "Workspace", id: "LIST" }],
    }),
    patchWorkspace: build.mutation<
      ServerWorkspace,
      { id: string; patch: Partial<Pick<ServerWorkspace, "name" | "description" | "icon" | "color">> }
    >({
      query: ({ id, patch }) => ({
        url: `/workspaces/${id}`,
        method: "PATCH",
        body: patch,
      }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: "Workspace", id },
        { type: "Workspace", id: "LIST" },
      ],
    }),
    deleteWorkspace: build.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/workspaces/${id}`, method: "DELETE" }),
      invalidatesTags: [{ type: "Workspace", id: "LIST" }],
    }),

    // ── Agents ────────────────────────────────────────────────────────
    getAgents: build.query<ServerAgent[], void>({
      query: () => "/agents",
      providesTags: (result) =>
        result
          ? [
              ...result.map((a) => ({ type: "Agent" as const, id: a.id })),
              { type: "Agent" as const, id: "LIST" },
            ]
          : [{ type: "Agent", id: "LIST" }],
    }),
    createAgent: build.mutation<
      ServerAgent,
      {
        name: string;
        model?: string;
      }
    >({
      query: (body) => ({ url: "/agents", method: "POST", body }),
      invalidatesTags: [{ type: "Agent", id: "LIST" }],
    }),
    patchAgent: build.mutation<
      ServerAgent,
      {
        id: string;
        patch: Partial<Pick<ServerAgent, "name" | "model">>;
      }
    >({
      query: ({ id, patch }) => ({
        url: `/agents/${id}`,
        method: "PATCH",
        body: patch,
      }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: "Agent", id },
        { type: "Agent", id: "LIST" },
        // WorkspaceAgents extends Agent — invalidate so the compose picker
        // picks up the renamed agent without a full reload.
        { type: "WorkspaceAgents", id: "LIST" },
      ],
    }),
    deleteAgent: build.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/agents/${id}`, method: "DELETE" }),
      invalidatesTags: (_r, _e, id) => [
        { type: "Agent", id },
        { type: "Agent", id: "LIST" },
        // Agent delete cascades to chats on the server; mirror that here.
        { type: "Chat", id: "LIST" },
        // Membership rows go too — refresh per-workspace lists.
        { type: "WorkspaceAgents", id: "LIST" },
      ],
    }),

    // ── Workspace ↔ Agent membership ──────────────────────────────────
    getWorkspaceAgents: build.query<ServerWorkspaceAgent[], string>({
      query: (workspaceId) => `/workspaces/${workspaceId}/agents`,
      keepUnusedDataFor: 30 * 60,
      providesTags: (_r, _e, workspaceId) => [
        { type: "WorkspaceAgents", id: workspaceId },
        { type: "WorkspaceAgents", id: "LIST" },
      ],
    }),
    addWorkspaceAgent: build.mutation<
      unknown,
      { workspaceId: string; agentId: string }
    >({
      query: ({ workspaceId, agentId }) => ({
        url: `/workspaces/${workspaceId}/agents`,
        method: "POST",
        body: { agentId },
      }),
      invalidatesTags: (_r, _e, { workspaceId }) => [
        { type: "WorkspaceAgents", id: workspaceId },
      ],
    }),
    removeWorkspaceAgent: build.mutation<
      { ok: true },
      { workspaceId: string; agentId: string }
    >({
      query: ({ workspaceId, agentId }) => ({
        url: `/workspaces/${workspaceId}/agents/${agentId}`,
        method: "DELETE",
      }),
      invalidatesTags: (_r, _e, { workspaceId }) => [
        { type: "WorkspaceAgents", id: workspaceId },
      ],
    }),

    // ── Chats ─────────────────────────────────────────────────────────
    getChats: build.query<ServerChat[], { workspaceId?: string } | void>({
      query: (arg) => {
        const workspaceId = arg?.workspaceId;
        return workspaceId
          ? `/chats?workspaceId=${encodeURIComponent(workspaceId)}`
          : "/chats";
      },
      keepUnusedDataFor: 30 * 60,
      providesTags: (result) =>
        result
          ? [
              ...result.map((c) => ({ type: "Chat" as const, id: c.id })),
              { type: "Chat" as const, id: "LIST" },
            ]
          : [{ type: "Chat", id: "LIST" }],
    }),
    getChat: build.query<ServerChat, string>({
      query: (id) => `/chats/${id}`,
      providesTags: (_result, _error, id) => [{ type: "Chat", id }],
    }),
    createChat: build.mutation<
      ServerChat,
      { workspaceId: string; agentId: string; title: string; goal?: string }
    >({
      query: (body) => ({ url: "/chats", method: "POST", body }),
      // Do not invalidate Chat/LIST here: the refetch can briefly return a
      // stale list that does not include the just-created chat. Insert the
      // fulfilled chat directly, then let WS/refetches converge later.
      async onQueryStarted({ workspaceId }, { dispatch, queryFulfilled }) {
        const insertCreatedChat = (created: ServerChat) => (draft: ServerChat[]) => {
          if (draft.some((c) => c.id === created.id)) return;
          draft.unshift(created);
        };

        try {
          const { data: created } = await queryFulfilled;
          dispatch(api.util.updateQueryData("getChats", { workspaceId }, insertCreatedChat(created)));
          dispatch(api.util.updateQueryData("getChats", undefined, insertCreatedChat(created)));
        } catch {
          // The mutation error is surfaced by the caller; there is no cache
          // update to roll back because we only insert after fulfillment.
        }
      },
    }),
    patchChat: build.mutation<
      ServerChat,
      {
        id: string;
        patch: Partial<Pick<ServerChat, "title" | "goal" | "agentId" | "unread">>;
      }
    >({
      query: ({ id, patch }) => ({
        url: `/chats/${id}`,
        method: "PATCH",
        body: patch,
      }),
      // The server emits `chat.updated` via WS after a successful PATCH,
      // which the WS middleware handles by patching the RTK Query chat
      // cache directly (both workspace-scoped and unscoped lists).
      //
      // We apply the patch optimistically in onQueryStarted and skip tag
      // invalidation entirely. Invalidating Chat LIST would trigger a
      // full getChats refetch that races the WS update: the refetch can
      // arrive before the WS event and overwrite the optimistic patch,
      // briefly flashing stale state (e.g. unread=true) in the sidebar.
      // The WS chat.updated event is the authoritative follow-up.
      async onQueryStarted({ id, patch }, { dispatch, queryFulfilled, getState }) {
        // Optimistically patch every `getChats` cache variant that
        // contains this chat. The app typically only subscribes to the
        // workspace-scoped query, so the unscoped cache may be empty.
        // We iterate RTK Query cache keys to find all live variants.
        const patchFn = (draft: ServerChat[]) => {
          const idx = draft.findIndex((c) => c.id === id);
          if (idx >= 0) Object.assign(draft[idx], patch);
        };
        const undos: Array<{ undo(): void }> = [];
        undos.push(dispatch(api.util.updateQueryData("getChats", undefined, patchFn)));

        const state = getState() as Record<string, unknown>;
        const apiState = state[api.reducerPath] as { queries?: Record<string, { data?: ServerChat[] }> } | undefined;
        if (apiState?.queries) {
          for (const [key, entry] of Object.entries(apiState.queries)) {
            if (!key.startsWith("getChats(")) continue;
            const chats = entry?.data;
            if (!Array.isArray(chats)) continue;
            const chat = chats.find((c: ServerChat) => c.id === id);
            if (chat) {
              undos.push(dispatch(api.util.updateQueryData("getChats", { workspaceId: chat.workspaceId }, patchFn)));
            }
          }
        }
        try {
          await queryFulfilled;
        } catch {
          for (const u of undos) u.undo();
        }
      },
    }),
    deleteChat: build.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/chats/${id}`, method: "DELETE" }),
      invalidatesTags: (_r, _e, id) => [
        { type: "Chat", id },
        { type: "Chat", id: "LIST" },
        { type: "Message", id: "CROSS" },
      ],
    }),

    // ── Messages (per chat) ───────────────────────────────────────────
    getChatMessages: build.query<
      ListMessagesResponse,
      { chatId: string; cursor?: string; before?: string; full?: boolean; limit?: number }
    >({
      query: ({ chatId, cursor, before, full, limit }) => {
        const params = new URLSearchParams();
        if (cursor) params.set("cursor", cursor);
        if (before) params.set("before", before);
        if (!full) params.set("view", "timeline");
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        return `/chats/${chatId}/messages${qs ? `?${qs}` : ""}`;
      },
      providesTags: (_r, _e, { chatId }) => [
        { type: "Message", id: `CHAT_${chatId}` },
      ],
      // All pages for the same chatId share a single cache entry so
      // older pages merge into the existing array.
      serializeQueryArgs: ({ queryArgs }) => `${queryArgs.chatId}:${queryArgs.full ? "full" : "compact"}`,
      merge: (existing, incoming, { arg }) => {
        if (arg.before) {
          // Loading older messages — prepend to existing items, dedup by id.
          const existingIds = new Set(existing.items.map((m) => m.id));
          const newItems = incoming.items.filter(
            (m) => !existingIds.has(m.id),
          );
          existing.items = [...newItems, ...existing.items];
          // Update prevCursor from the older-page response.
          existing.prevCursor = incoming.prevCursor;
        } else if (arg.cursor) {
          // Forward pagination (not used for scrollback, but keep for
          // potential forward paging). Append new items.
          const existingIds = new Set(existing.items.map((m) => m.id));
          const newItems = incoming.items.filter(
            (m) => !existingIds.has(m.id),
          );
          existing.items = [...existing.items, ...newItems];
          existing.cursor = incoming.cursor;
        } else {
          // Initial load (no cursor/before) — replace entirely.
          existing.items = incoming.items;
          existing.cursor = incoming.cursor;
          existing.prevCursor = incoming.prevCursor;
        }
      },
      forceRefetch: ({ currentArg, previousArg }) => {
        return currentArg !== previousArg;
      },
    }),
    postChatMessage: build.mutation<
      ServerMessage,
      {
        chatId: string;
        content: string;
        attachments?: AttachmentRef[];
        /** Files to upload with this message. Switches the request to
         * multipart so the server writes them under
         * `.chats/{chatId}/messages/{msgId}/` keyed by the new message
         * id (no upload-then-attach two-step). */
        files?: File[];
        kind?: "chat" | "task" | "summary";
        title?: string;
        executeAt?: string;
        cron?: string;
        goal?: string | null;
      }
    >({
      query: ({ chatId, content, attachments, files, kind, title, executeAt, cron, goal }) => {
        const url = `/chats/${chatId}/messages`;
        if (files && files.length > 0) {
          const fd = new FormData();
          fd.append("content", content);
          if (attachments && attachments.length > 0) {
            fd.append("attachments", JSON.stringify(attachments));
          }
          for (const f of files) fd.append("attachment", f, f.name);
          if (kind) fd.append("kind", kind);
          if (title) fd.append("title", title);
          if (executeAt) fd.append("executeAt", executeAt);
          if (cron) fd.append("cron", cron);
          if (goal !== undefined) fd.append("goal", goal ?? "");
          return { url, method: "POST", body: fd };
        }
        const body: Record<string, unknown> = { content };
        if (attachments && attachments.length > 0) body.attachments = attachments;
        if (kind) body.kind = kind;
        if (title) body.title = title;
        if (executeAt) body.executeAt = executeAt;
        if (cron) body.cron = cron;
        if (goal !== undefined) body.goal = goal;
        return { url, method: "POST", body };
      },
      // Message cache is maintained via WS events (message.appended /
      // message.updated). Invalidating Message tags here would trigger a
      // full refetch that races with those WS patches — the refetch
      // response can overwrite a more-recent WS state transition, leaving
      // an agent_turn stuck in "pending" or "running" and the Thinking…
      // indicator permanently visible.
      //
      // Chat tags are NOT invalidated here either: the WS middleware
      // already handles Chat cache updates for each message.appended event
      // (tag invalidation for non-viewed chats, quiet markRead for the
      // viewed chat). Invalidating Chat tags here races the markRead and
      // causes a stale unread=true to flash in the sidebar.
      invalidatesTags: [],
    }),
    patchMessage: build.mutation<
      ServerMessage,
      {
        chatId: string;
        messageId: string;
        patch: Partial<{
          content: unknown;
          state: "cancelled" | "pending" | "paused";
          executeAt: string | null;
          cron: string | null;
          title: string | null;
          assigneeId: string | null;
        }>;
      }
    >({
      query: ({ chatId, messageId, patch }) => ({
        url: `/chats/${chatId}/messages/${messageId}`,
        method: "PATCH",
        body: patch,
      }),
      invalidatesTags: (_r, _e, { chatId }) => [
        { type: "Message", id: `CHAT_${chatId}` },
        { type: "Message", id: "CROSS" },
      ],
    }),
    deleteMessage: build.mutation<
      { ok: true },
      { chatId: string; messageId: string }
    >({
      query: ({ chatId, messageId }) => ({
        url: `/chats/${chatId}/messages/${messageId}`,
        method: "DELETE",
      }),
      invalidatesTags: (_r, _e, { chatId }) => [
        { type: "Message", id: `CHAT_${chatId}` },
        { type: "Message", id: "CROSS" },
      ],
    }),
    runMessage: build.mutation<
      ServerMessage,
      { chatId: string; messageId: string }
    >({
      query: ({ chatId, messageId }) => ({
        url: `/chats/${chatId}/messages/${messageId}/run`,
        method: "POST",
      }),
      async onQueryStarted({ chatId, messageId }, { dispatch, queryFulfilled, getState }) {
        // Dragging a plain user task to Active starts a background run and is
        // also an explicit user-owned board-status change. Scheduled/cron tasks
        // must not have their parent cache rewritten to running: their Active
        // display is derived from the task_run child while the agent is in
        // flight, then the parent remains Scheduled/Paused.
        const undos = updateLiveMessageCaches(dispatch, getState, { chatId, messageId }, (msg) => {
          if (msg.kind === "task" && msg.role === "user" && !msg.executeAt && !msg.cron) msg.state = "running";
        });

        try {
          const { data } = await queryFulfilled;
          updateLiveMessageCaches(dispatch, getState, { chatId, messageId }, (msg) => {
            Object.assign(msg, data);
          });
          const userOwnedPlainTask = data.kind === "task" && data.role === "user" && !data.executeAt && !data.cron;
          if (!userOwnedPlainTask) {
            dispatch(api.util.invalidateTags([
              { type: "Message", id: `CHAT_${chatId}` },
              { type: "Message", id: "CROSS" },
            ]));
          }
        } catch {
          for (const u of undos) u.undo();
        }
      },
      invalidatesTags: [],
    }),
    /**
     * Snapshot history for a `summary`-content message. Each PATCH and
     * each AI-driven refresh writes the prior body into
     * `.chats/{chatId}/notes/.history/`. Used by the dev UI to show a
     * red/green diff against the most recent snapshot whenever a summary
     * is regenerated (memory-system spec, P2.5).
     */
    getSummaryHistory: build.query<
      { versions: Array<{ timestamp: string; body: string }> },
      { chatId: string; messageId: string }
    >({
      query: ({ chatId, messageId }) => ({
        url: `/chats/${chatId}/messages/${messageId}/summary-history`,
      }),
      providesTags: (_r, _e, { messageId }) => [
        { type: "Message", id: `SUMMARY_HISTORY_${messageId}` },
      ],
    }),

    // ── Cross-chat messages (runs, today) ─────────────────────────────
    getMessages: build.query<ListMessagesResponse, MessagesFilter>({
      query: (filter) => buildMessagesQuery(filter),
      keepUnusedDataFor: 30 * 60,
      providesTags: [{ type: "Message", id: "CROSS" }],
    }),

    // ── Library ───────────────────────────────────────────────────────
    getLibrary: build.query<
      ListLibraryResponse,
      { workspaceId?: string; cursor?: string; limit?: number; showHidden?: boolean; pinned?: boolean } | void
    >({
      query: (arg) => {
        const p = new URLSearchParams();
        if (arg?.workspaceId) p.set("workspaceId", arg.workspaceId);
        if (arg?.cursor) p.set("cursor", arg.cursor);
        if (arg?.limit !== undefined) p.set("limit", String(arg.limit));
        if (arg?.showHidden) p.set("showHidden", "true");
        if (arg?.pinned) p.set("pinned", "true");
        const qs = p.toString();
        return qs ? `/library?${qs}` : "/library";
      },
      keepUnusedDataFor: 30 * 60,
      providesTags: [{ type: "LibraryFile", id: "LIST" }],
    }),
    getLibraryFile: build.query<
      ServerFile,
      { workspaceId: string; path: string }
    >({
      query: ({ workspaceId, path }) =>
        `/library/meta?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`,
      providesTags: (_r, _e, { path }) => [{ type: "LibraryFile", id: path }],
    }),
    deleteLibraryFile: build.mutation<
      { ok: true },
      { workspaceId: string; path: string }
    >({
      query: ({ workspaceId, path }) => ({
        url: `/library?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`,
        method: "DELETE",
      }),
      invalidatesTags: [{ type: "LibraryFile", id: "LIST" }],
    }),
    uploadLibraryFile: build.mutation<
      ServerFile,
      { workspaceId?: string; file: File; subpath?: string }
    >({
      query: ({ workspaceId, file, subpath }) => {
        const fd = new FormData();
        if (subpath) fd.append("subpath", subpath);
        fd.append("file", file, file.name);
        const url = workspaceId
          ? `/library?workspaceId=${encodeURIComponent(workspaceId)}`
          : "/library";
        return { url, method: "POST", body: fd };
      },
      invalidatesTags: [{ type: "LibraryFile", id: "LIST" }],
    }),
    saveLibraryContent: build.mutation<
      ServerFile,
      { workspaceId: string; path: string; content: string; contentType?: string }
    >({
      query: ({ workspaceId, path, content, contentType }) => ({
        url: `/library/content?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`,
        method: "PUT",
        headers: { "Content-Type": contentType ?? "application/octet-stream" },
        body: content,
      }),
      invalidatesTags: [{ type: "LibraryFile", id: "LIST" }],
    }),
    createLibraryFolder: build.mutation<
      { path: string; name: string; createdAt: string },
      { workspaceId: string; path: string }
    >({
      query: ({ workspaceId, path }) => ({
        url: `/library/folder?workspaceId=${encodeURIComponent(workspaceId)}`,
        method: "POST",
        body: { path },
      }),
      invalidatesTags: [{ type: "LibraryFile", id: "LIST" }],
    }),
    createLibraryLink: build.mutation<
      ServerFile,
      { workspaceId: string; url: string; name?: string; subpath?: string }
    >({
      query: ({ workspaceId, url, name, subpath }) => ({
        url: `/library/link?workspaceId=${encodeURIComponent(workspaceId)}`,
        method: "POST",
        body: { url, name, subpath },
      }),
      invalidatesTags: [{ type: "LibraryFile", id: "LIST" }],
    }),
    moveLibraryEntry: build.mutation<
      { kind: "file" | "folder"; path: string },
      { workspaceId: string; from: string; to: string }
    >({
      query: ({ workspaceId, from, to }) => ({
        url: `/library?workspaceId=${encodeURIComponent(workspaceId)}`,
        method: "PATCH",
        body: { from, to },
      }),
      invalidatesTags: [{ type: "LibraryFile", id: "LIST" }],
    }),

    // ── Chat attachments ──────────────────────────────────────────────
    // "attachments" covers both user-visible chat files (non-dot) and
    // agent-generated artifacts (dot-prefixed). Pass showHidden=true to
    // include the artifact set for the chat's Artifacts panel. Pass
    // includeArtifacts=true to also include agent-written files/dirs from
    // .chats/{id}/artifacts/ — used by the Files panel.
    getChatArtifacts: build.query<
      ServerFile[],
      { chatId: string; showHidden?: boolean; includeArtifacts?: boolean }
    >({
      query: ({ chatId, showHidden, includeArtifacts }) => {
        const params = new URLSearchParams()
        if (showHidden) params.set("showHidden", "true")
        if (includeArtifacts) params.set("includeArtifacts", "true")
        const qs = params.toString()
        return qs
          ? `/chats/${chatId}/attachments?${qs}`
          : `/chats/${chatId}/attachments`
      },
      providesTags: (_r, _e, { chatId }) => [
        { type: "ChatArtifact", id: `CHAT_${chatId}` },
      ],
    }),
    // Pins a workspace-library file to the chat by symlinking it into
    // `.chats/{chatId}/attachments/`. The library file is untouched.
    // Idempotent — pinning the same file twice is a no-op server-side.
    pinChatLibraryRef: build.mutation<
      ServerFile,
      { chatId: string; path: string }
    >({
      query: ({ chatId, path }) => ({
        url: `/chats/${chatId}/library-refs`,
        method: "POST",
        body: { path },
      }),
      invalidatesTags: (_r, _e, { chatId }) => [
        { type: "ChatArtifact", id: `CHAT_${chatId}` },
      ],
    }),
    // Promotes a chat-scoped attachment to the primary workspace library.
    // The original `.chats/{chatId}/attachments/{name}` becomes a symlink
    // pointing at the new library path so the chat's "In this chat" list
    // continues to surface the file.
    saveChatAttachmentToLibrary: build.mutation<
      ServerFile,
      { chatId: string; name: string; destSubpath?: string }
    >({
      query: ({ chatId, name, destSubpath }) => ({
        url: `/chats/${chatId}/save-to-library`,
        method: "POST",
        body: { name, ...(destSubpath ? { destSubpath } : {}) },
      }),
      invalidatesTags: (_r, _e, { chatId }) => [
        { type: "ChatArtifact", id: `CHAT_${chatId}` },
        { type: "LibraryFile", id: "LIST" },
      ],
    }),
    // Removes a single entry from `.chats/{chatId}/attachments/`.
    // Pinned library files lose only their symlink (source untouched);
    // direct chat uploads are permanently removed. Server route accepts
    // the basename via `?name=` to avoid filename-encoding traps in the
    // URL path itself.
    deleteChatAttachment: build.mutation<
      { ok: true },
      { chatId: string; name: string }
    >({
      query: ({ chatId, name }) => ({
        url: `/chats/${chatId}/attachments?name=${encodeURIComponent(name)}`,
        method: "DELETE",
      }),
      invalidatesTags: (_r, _e, { chatId }) => [
        { type: "ChatArtifact", id: `CHAT_${chatId}` },
      ],
    }),

    // ── Library pins ─────────────────────────────────────────────────
    pinLibraryItem: build.mutation<
      { ok: true },
      { workspaceId: string; path: string }
    >({
      query: ({ workspaceId, path }) => ({
        url: `/workspaces/${workspaceId}/library-pins`,
        method: "POST",
        body: { path },
      }),
      invalidatesTags: [{ type: "LibraryFile", id: "LIST" }],
    }),
    unpinLibraryItem: build.mutation<
      { ok: true },
      { workspaceId: string; path: string }
    >({
      query: ({ workspaceId, path }) => ({
        url: `/workspaces/${workspaceId}/library-pins`,
        method: "DELETE",
        body: { path },
      }),
      invalidatesTags: [{ type: "LibraryFile", id: "LIST" }],
    }),

    // ── Search ────────────────────────────────────────────────────────
    search: build.query<
      SearchResult[],
      { q: string; scope?: "chats" | "artifacts" | "library" | "files" | "all"; workspaceId?: string; chatId?: string; kind?: string }
    >({
      query: ({ q, scope, workspaceId, chatId, kind }) => {
        const p = new URLSearchParams({ q });
        if (scope) p.set("scope", scope);
        if (workspaceId) p.set("workspaceId", workspaceId);
        if (chatId) p.set("chatId", chatId);
        if (kind) p.set("kind", kind);
        return `/search?${p.toString()}`;
      },
    }),

    // ── Tools / models ────────────────────────────────────────────────
    getModels: build.query<ModelRef[], { provider?: string } | void>({
      query: (arg) => {
        const provider = arg?.provider;
        return provider
          ? `/tools/models?provider=${encodeURIComponent(provider)}`
          : "/tools/models";
      },
      providesTags: ["Models"],
    }),
  }),
});

export const {
  useGetMeQuery,
  usePatchMeMutation,
  useChangePasswordMutation,
  useGetProviderKeysQuery,
  usePutProviderKeysMutation,
  useGetProvidersMetaQuery,
  usePutProvidersMetaMutation,
  useGetLocalSourcesQuery,
  usePutLocalSourceMutation,
  useGetWorkspacesQuery,
  useCreateWorkspaceMutation,
  usePatchWorkspaceMutation,
  useDeleteWorkspaceMutation,
  useGetAgentsQuery,
  useCreateAgentMutation,
  usePatchAgentMutation,
  useDeleteAgentMutation,
  useGetWorkspaceAgentsQuery,
  useAddWorkspaceAgentMutation,
  useRemoveWorkspaceAgentMutation,
  useGetChatsQuery,
  useGetChatQuery,
  useCreateChatMutation,
  usePatchChatMutation,
  useDeleteChatMutation,
  useGetChatMessagesQuery,
  usePostChatMessageMutation,
  usePatchMessageMutation,
  useDeleteMessageMutation,
  useRunMessageMutation,
  useGetSummaryHistoryQuery,
  useGetMessagesQuery,
  useGetLibraryQuery,
  useGetLibraryFileQuery,
  useDeleteLibraryFileMutation,
  useUploadLibraryFileMutation,
  useSaveLibraryContentMutation,
  useCreateLibraryFolderMutation,
  useCreateLibraryLinkMutation,
  useMoveLibraryEntryMutation,
  useGetChatArtifactsQuery,
  usePinChatLibraryRefMutation,
  useSaveChatAttachmentToLibraryMutation,
  useDeleteChatAttachmentMutation,
  usePinLibraryItemMutation,
  useUnpinLibraryItemMutation,
  useSearchQuery,
  useGetModelsQuery,
} = api;
