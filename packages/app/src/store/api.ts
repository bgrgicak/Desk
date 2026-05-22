import {
  createApi,
  fetchBaseQuery,
  type BaseQueryFn,
} from "@reduxjs/toolkit/query/react";
import { getSessionToken } from "@/auth/session";
import type {
  AttachmentRef,
  ConnectorConnection,
  ListLibraryFoldersResponse,
  ListLibraryResponse,
  ListMessagesResponse,
  MessagesFilter,
  SearchLibraryResponse,
  ServerAgent,
  ServerChat,
  ServerFile,
  ServerMessage,
  ServerUser,
  ServerWorkspace,
  ServerWorkspaceAgent,
  WorkspaceConnectorGrant,
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

function isInternalMessageForChatActivity(msg: ServerMessage): boolean {
  const contentType = msg.content?.type;
  const kind = msg.kind ?? "chat";
  return (
    contentType === "agent_turn" ||
    contentType === "summary_request" ||
    contentType === "summary" ||
    contentType === "feedback" ||
    kind === "summary"
  );
}

function bumpChatActivityInList(draft: ServerChat[], chatId: string, updatedAt: string): void {
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
  draft.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

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
      sessionStorage.removeItem("roomy.session.token");
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

export function buildMessagesQuery(f: MessagesFilter): string {
  const params = new URLSearchParams();
  params.set("view", f.full ? "full" : "compact");
  if (f.workspaceId) params.set("workspaceId", f.workspaceId);
  if (f.chatId) params.set("chatId", f.chatId);
  if (f.state && f.state.length > 0) params.set("state", f.state.join(","));
  if (f.scheduled !== undefined)
    params.set("scheduled", String(f.scheduled));
  if (f.unread !== undefined)
    params.set("unread", String(f.unread));
  if (f.contentKind && f.contentKind.length > 0)
    params.set("contentKind", f.contentKind.join(","));
  if (f.kind && f.kind.length > 0) params.set("kind", f.kind.join(","));
  if (f.taskStatus && f.taskStatus.length > 0)
    params.set("taskStatus", f.taskStatus.join(","));
  if (f.parentId) params.set("parentId", f.parentId);
  if (f.since) params.set("since", f.since);
  if (f.limit !== undefined) params.set("limit", String(f.limit));
  if (f.cursor) params.set("cursor", f.cursor);
  const qs = params.toString();
  return qs ? `/messages?${qs}` : "/messages";
}

export function buildChatMessagesQuery({ chatId, cursor, before, full, limit }: { chatId: string; cursor?: string; before?: string; full?: boolean; limit?: number }): string {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (before) params.set("before", before);
  params.set("view", full ? "full" : "timeline");
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return `/chats/${chatId}/messages${qs ? `?${qs}` : ""}`;
}

export type ChatMessagesQueryArgs = { chatId: string; cursor?: string; before?: string; full?: boolean; limit?: number };

export function shouldForceRefetchChatMessages(currentArg?: ChatMessagesQueryArgs, previousArg?: ChatMessagesQueryArgs): boolean {
  if (!currentArg || !previousArg) return currentArg !== previousArg;
  return currentArg.chatId !== previousArg.chatId
    || currentArg.cursor !== previousArg.cursor
    || currentArg.before !== previousArg.before
    || currentArg.full !== previousArg.full
    || currentArg.limit !== previousArg.limit;
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
    "ConnectorConnections",
    "WorkspaceConnectorGrants",
    "ProvidersMeta",
    "LocalSources",
    "Models",
    "VaultStatus",
  ],
  endpoints: (build) => ({
    // ── Me ────────────────────────────────────────────────────────────
    getMe: build.query<ServerUser, void>({
      query: () => "/me",
      providesTags: ["Me"],
    }),
    /**
     * Returns the hub-backed "Ask AI" chat for the current user (the
     * oldest chat in their hub workspace). Server creates it on first
     * call. The hub workspace itself is not exposed via the workspaces
     * API; this is the single seam through which the Home → Ask AI
     * surface discovers its chat id.
     */
    getAskAiChat: build.query<ServerChat, void>({
      query: () => "/me/ask-ai-chat",
      providesTags: (result) =>
        result ? [{ type: "Chat", id: result.id }] : [],
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
      invalidatesTags: ["ProviderKeys", "ProvidersMeta", "ConnectorConnections", "Models"],
    }),
    getVaultStatus: build.query<{ exists: boolean; locked: boolean }, void>({
      query: () => "/vault/status",
      providesTags: ["VaultStatus"],
    }),
    setupVault: build.mutation<{ ok: true }, { password: string }>({
      query: (body) => ({ url: "/vault/setup", method: "POST", body }),
      // Unlocking the vault may unblock any cached "locked → null" reads,
      // so refresh everything that depended on vault state.
      invalidatesTags: ["VaultStatus", "ProviderKeys", "ConnectorConnections", "Models"],
    }),
    unlockVault: build.mutation<{ ok: true }, { password: string }>({
      query: (body) => ({ url: "/vault/unlock", method: "POST", body }),
      invalidatesTags: ["VaultStatus", "ProviderKeys", "ConnectorConnections", "Models"],
    }),
    lockVault: build.mutation<{ ok: true }, void>({
      query: () => ({ url: "/vault/lock", method: "POST" }),
      invalidatesTags: ["VaultStatus", "ProviderKeys", "ConnectorConnections", "Models"],
    }),
    getConnectorConnections: build.query<
      ConnectorConnection[],
      { providerId?: string } | void
    >({
      query: (arg) => {
        const providerId = arg?.providerId;
        return providerId ? `/me/connections?providerId=${encodeURIComponent(providerId)}` : "/me/connections";
      },
      transformResponse: (r: { connections: ConnectorConnection[] }) => r.connections,
      providesTags: ["ConnectorConnections"],
    }),
    createConnectorConnection: build.mutation<
      ConnectorConnection,
      {
        providerId: string;
        displayName: string;
        externalAccountId?: string;
        scopes?: string[];
        capabilities?: string[];
        metadata?: Record<string, unknown>;
        credentials?: Record<string, unknown>;
        status?: ConnectorConnection["status"];
        isDefault?: boolean;
      }
    >({
      query: (body) => ({ url: "/me/connections", method: "POST", body }),
      transformResponse: (r: { connection: ConnectorConnection }) => r.connection,
      invalidatesTags: ["ConnectorConnections", "ProviderKeys", "Models"],
    }),
    patchConnectorConnection: build.mutation<
      ConnectorConnection,
      { id: string; patch: Partial<Pick<ConnectorConnection, "displayName" | "externalAccountId" | "scopes" | "capabilities" | "metadata" | "status" | "isDefault">> & { credentials?: Record<string, unknown> | null } }
    >({
      query: ({ id, patch }) => ({ url: `/me/connections/${encodeURIComponent(id)}`, method: "PATCH", body: patch }),
      transformResponse: (r: { connection: ConnectorConnection }) => r.connection,
      invalidatesTags: ["ConnectorConnections", "WorkspaceConnectorGrants", "ProviderKeys", "Models"],
    }),
    deleteConnectorConnection: build.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/me/connections/${encodeURIComponent(id)}`, method: "DELETE" }),
      invalidatesTags: ["ConnectorConnections", "WorkspaceConnectorGrants", "ProviderKeys", "Models"],
    }),
    getWorkspaceConnectorGrants: build.query<WorkspaceConnectorGrant[], string>({
      query: (workspaceId) => `/workspaces/${encodeURIComponent(workspaceId)}/connections`,
      transformResponse: (r: { grants: WorkspaceConnectorGrant[] }) => r.grants,
      providesTags: (_result, _err, workspaceId) => [{ type: "WorkspaceConnectorGrants", id: workspaceId }],
    }),
    putWorkspaceConnectorGrants: build.mutation<
      WorkspaceConnectorGrant[],
      { workspaceId: string; grants: Array<{ connectionId: string; providerId: string; grantedCapabilities?: string[]; isDefault?: boolean }> }
    >({
      query: ({ workspaceId, grants }) => ({ url: `/workspaces/${encodeURIComponent(workspaceId)}/connections`, method: "PUT", body: { grants } }),
      transformResponse: (r: { grants: WorkspaceConnectorGrant[] }) => r.grants,
      invalidatesTags: (_result, _err, arg) => [{ type: "WorkspaceConnectorGrants", id: arg.workspaceId }],
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
      invalidatesTags: [
        { type: "Agent", id: "LIST" },
        { type: "WorkspaceAgents", id: "LIST" },
      ],
    }),
    patchAgent: build.mutation<
      ServerAgent,
      {
        id: string;
        patch: Partial<Pick<ServerAgent, "name" | "model" | "enabled">>;
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
    reorderAgents: build.mutation<ServerAgent[], string[]>({
      query: (ids) => ({
        url: "/agents/order",
        method: "PUT",
        body: { ids },
      }),
      invalidatesTags: [
        { type: "Agent", id: "LIST" },
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
      ChatMessagesQueryArgs
    >({
      query: buildChatMessagesQuery,
      providesTags: (_r, _e, { chatId }) => [
        { type: "Message", id: `CHAT_${chatId}` },
      ],
      // All pages for the same chatId share a single cache entry so
      // older pages merge into the existing array.
      serializeQueryArgs: ({ queryArgs }) => `${queryArgs.chatId}:${queryArgs.full ? "full" : "timeline"}`,
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
      forceRefetch: ({ currentArg, previousArg }) => shouldForceRefetchChatMessages(currentArg, previousArg),
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
      async onQueryStarted({ chatId }, { dispatch, queryFulfilled, getState }) {
        try {
          const { data: message } = await queryFulfilled;
          if (isInternalMessageForChatActivity(message)) return;
          const updatedAt = message.createdAt;

          dispatch(
            api.util.updateQueryData("getChats", undefined, (draft) => {
              bumpChatActivityInList(draft, chatId, updatedAt);
            }),
          );

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
                api.util.updateQueryData("getChats", { workspaceId: chat.workspaceId }, (draft) => {
                  bumpChatActivityInList(draft, chatId, updatedAt);
                }),
              );
            }
          }
        } catch {
          // The mutation error is surfaced by the caller; leave caches as-is.
        }
      },
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
          kind: "chat";
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
    /**
     * Open a thread anchored at `messageId`. Server creates a new chat
     * with the anchor message mounted, inserts the user-supplied first
     * message, and fires the agent. Returns the thread chat plus the
     * patched anchor (now carries `threadChatId`) so the caller can
     * navigate to it and patch its local cache.
     */
    createThread: build.mutation<
      { chat: ServerChat; message: ServerMessage; anchorMessage: ServerMessage },
      { chatId: string; messageId: string; content: string; workspaceId?: string; agentId?: string }
    >({
      query: ({ chatId, messageId, content, workspaceId, agentId }) => ({
        url: `/chats/${chatId}/messages/${messageId}/thread`,
        method: "POST",
        body: { content, workspaceId, agentId },
      }),
      invalidatesTags: (_r, _e, { chatId }) => [
        { type: "Chat", id: "LIST" },
        { type: "Message", id: `CHAT_${chatId}` },
      ],
    }),
    /**
     * Records a 👍 / 👎 reaction on an agent reply. Server inserts a
     * `role: 'system'` message with `feedback` content so the workspace's
     * daily reflection can read the reaction alongside the surrounding
     * chat. WS `message.appended` keeps the message cache up to date —
     * we don't optimistically insert here.
     */
    postMessageFeedback: build.mutation<
      ServerMessage,
      { chatId: string; messageId: string; rating: "up" | "down" }
    >({
      query: ({ chatId, messageId, rating }) => ({
        url: `/chats/${chatId}/messages/${messageId}/feedback`,
        method: "POST",
        body: { rating },
      }),
      invalidatesTags: [],
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
        // Task runs are represented by task_run children. POST /run does not
        // mutate the parent task row — the task_run child carries the
        // run's lifecycle, and selectors derive the Active column from it.
        const undos: Array<{ undo: () => void }> = [];

        try {
          const { data } = await queryFulfilled;
          updateLiveMessageCaches(dispatch, getState, { chatId, messageId }, (msg) => {
            Object.assign(msg, data);
          });
          if (data.kind !== "task") {
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
    // Folder-scoped listing: returns only the immediate children of `path`
    // (default = workspace root). Use `useSearchLibraryQuery` for recursive
    // matching and `useGetLibraryFoldersQuery` for the full folder tree.
    getLibrary: build.query<
      ListLibraryResponse,
      { workspaceId?: string; path?: string; showHidden?: boolean; pinned?: boolean } | void
    >({
      query: (arg) => {
        const p = new URLSearchParams();
        if (arg?.workspaceId) p.set("workspaceId", arg.workspaceId);
        if (arg?.path) p.set("path", arg.path);
        if (arg?.showHidden) p.set("showHidden", "true");
        if (arg?.pinned) p.set("pinned", "true");
        const qs = p.toString();
        return qs ? `/library?${qs}` : "/library";
      },
      keepUnusedDataFor: 30 * 60,
      providesTags: [{ type: "LibraryFile", id: "LIST" }],
    }),
    getLibraryFolders: build.query<
      ListLibraryFoldersResponse,
      { workspaceId?: string; showHidden?: boolean } | void
    >({
      query: (arg) => {
        const p = new URLSearchParams();
        if (arg?.workspaceId) p.set("workspaceId", arg.workspaceId);
        if (arg?.showHidden) p.set("showHidden", "true");
        const qs = p.toString();
        return qs ? `/library/folders?${qs}` : "/library/folders";
      },
      keepUnusedDataFor: 30 * 60,
      providesTags: [{ type: "LibraryFile", id: "FOLDERS" }],
    }),
    searchLibrary: build.query<
      SearchLibraryResponse,
      { workspaceId: string; q: string; showHidden?: boolean; limit?: number }
    >({
      query: ({ workspaceId, q, showHidden, limit }) => {
        const p = new URLSearchParams();
        p.set("workspaceId", workspaceId);
        p.set("q", q);
        if (showHidden) p.set("showHidden", "true");
        if (limit !== undefined) p.set("limit", String(limit));
        return `/library/search?${p.toString()}`;
      },
      // Search is cheap-ish but still recursive; keep the cache around so
      // typing-then-retyping the same query doesn't refire the walk.
      keepUnusedDataFor: 5 * 60,
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
      invalidatesTags: [
        { type: "LibraryFile", id: "LIST" },
        { type: "LibraryFile", id: "FOLDERS" },
      ],
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
      invalidatesTags: [
        { type: "LibraryFile", id: "LIST" },
        { type: "LibraryFile", id: "FOLDERS" },
      ],
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
      invalidatesTags: [
        { type: "LibraryFile", id: "LIST" },
        { type: "LibraryFile", id: "FOLDERS" },
      ],
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
      invalidatesTags: [
        { type: "LibraryFile", id: "LIST" },
        { type: "LibraryFile", id: "FOLDERS" },
      ],
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
      invalidatesTags: [
        { type: "LibraryFile", id: "LIST" },
        { type: "LibraryFile", id: "FOLDERS" },
      ],
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
      invalidatesTags: [
        { type: "LibraryFile", id: "LIST" },
        { type: "LibraryFile", id: "FOLDERS" },
      ],
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
        { type: "LibraryFile", id: "FOLDERS" },
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
      invalidatesTags: [
        { type: "LibraryFile", id: "LIST" },
        { type: "LibraryFile", id: "FOLDERS" },
      ],
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
      invalidatesTags: [
        { type: "LibraryFile", id: "LIST" },
        { type: "LibraryFile", id: "FOLDERS" },
      ],
    }),

    // ── Chat pins ────────────────────────────────────────────────────
    pinChat: build.mutation<
      { ok: true },
      { workspaceId: string; chatId: string }
    >({
      query: ({ workspaceId, chatId }) => ({
        url: `/workspaces/${workspaceId}/chat-pins`,
        method: "POST",
        body: { chatId },
      }),
      // The WS chat.updated event refreshes per-chat caches, but invalidate
      // the chat list tag so the sidebar's pinned section repaints even when
      // the socket round-trip is in flight.
      invalidatesTags: [{ type: "Chat", id: "LIST" }],
    }),
    unpinChat: build.mutation<
      { ok: true },
      { workspaceId: string; chatId: string }
    >({
      query: ({ workspaceId, chatId }) => ({
        url: `/workspaces/${workspaceId}/chat-pins`,
        method: "DELETE",
        body: { chatId },
      }),
      invalidatesTags: [{ type: "Chat", id: "LIST" }],
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
    previewModels: build.mutation<
      ModelRef[],
      { provider?: string; providerKeys: Record<string, string> }
    >({
      query: (body) => ({
        url: "/tools/models/preview",
        method: "POST",
        body,
      }),
    }),
  }),
});

export const {
  useGetMeQuery,
  useGetAskAiChatQuery,
  usePatchMeMutation,
  useChangePasswordMutation,
  useGetProviderKeysQuery,
  usePutProviderKeysMutation,
  useGetVaultStatusQuery,
  useSetupVaultMutation,
  useUnlockVaultMutation,
  useLockVaultMutation,
  useGetConnectorConnectionsQuery,
  useCreateConnectorConnectionMutation,
  usePatchConnectorConnectionMutation,
  useDeleteConnectorConnectionMutation,
  useGetWorkspaceConnectorGrantsQuery,
  usePutWorkspaceConnectorGrantsMutation,
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
  useReorderAgentsMutation,
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
  usePostMessageFeedbackMutation,
  useCreateThreadMutation,
  useGetSummaryHistoryQuery,
  useGetMessagesQuery,
  useGetLibraryQuery,
  useLazyGetLibraryQuery,
  useGetLibraryFoldersQuery,
  useSearchLibraryQuery,
  useLazySearchLibraryQuery,
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
  usePinChatMutation,
  useUnpinChatMutation,
  useSearchQuery,
  useGetModelsQuery,
  usePreviewModelsMutation,
} = api;
