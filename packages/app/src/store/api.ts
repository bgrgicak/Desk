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

/**
 * If an authed call returns 401 the stored token is dead. Clear it and
 * reload so the App outer-render check sees no token and renders the
 * LoginScreen — without a reload the React tree stays wedged on the stale
 * token (the check runs once at mount and doesn't subscribe to
 * sessionStorage). The one-shot guard keeps a 401-storm from looping
 * the page.
 */
let reloadingFor401 = false;
const baseQuery: BaseQueryFn<
  Parameters<typeof rawBaseQuery>[0],
  unknown,
  unknown
> = async (args, api, extra) => {
  const result = await rawBaseQuery(args, api, extra);
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
  if (f.since) params.set("since", f.since);
  if (f.limit !== undefined) params.set("limit", String(f.limit));
  if (f.cursor) params.set("cursor", f.cursor);
  const qs = params.toString();
  return qs ? `/messages?${qs}` : "/messages";
}

export interface SearchResult {
  type: "file" | "chat" | "message";
  id: string;
  title: string;
  snippet?: string;
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
      Record<string, { name?: string }>,
      void
    >({
      query: () => "/me/providers/meta",
      transformResponse: (r: { meta: Record<string, { name?: string }> }) =>
        r.meta,
      providesTags: ["ProvidersMeta"],
    }),
    putProvidersMeta: build.mutation<
      Record<string, { name?: string }>,
      Record<string, { name?: string } | null>
    >({
      query: (meta) => ({
        url: "/me/providers/meta",
        method: "PUT",
        body: { meta },
      }),
      transformResponse: (r: { meta: Record<string, { name?: string }> }) =>
        r.meta,
      invalidatesTags: ["ProvidersMeta"],
    }),

    // ── Workspaces ────────────────────────────────────────────────────
    getWorkspaces: build.query<ServerWorkspace[], void>({
      query: () => "/workspaces",
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
        instructions?: string;
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
        patch: Partial<Pick<ServerAgent, "name" | "instructions" | "model">>;
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
      providesTags: (result) =>
        result
          ? [
              ...result.map((c) => ({ type: "Chat" as const, id: c.id })),
              { type: "Chat" as const, id: "LIST" },
            ]
          : [{ type: "Chat", id: "LIST" }],
    }),
    createChat: build.mutation<
      ServerChat,
      { workspaceId: string; agentId: string; title: string; goal?: string }
    >({
      query: (body) => ({ url: "/chats", method: "POST", body }),
      invalidatesTags: [{ type: "Chat", id: "LIST" }],
    }),
    patchChat: build.mutation<
      ServerChat,
      {
        id: string;
        patch: Partial<Pick<ServerChat, "title" | "goal" | "agentId">>;
      }
    >({
      query: ({ id, patch }) => ({
        url: `/chats/${id}`,
        method: "PATCH",
        body: patch,
      }),
      invalidatesTags: (_r, _e, { id }) => [
        { type: "Chat", id },
        { type: "Chat", id: "LIST" },
      ],
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
      { chatId: string; cursor?: string }
    >({
      query: ({ chatId, cursor }) => {
        const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        return `/chats/${chatId}/messages${qs}`;
      },
      providesTags: (_r, _e, { chatId }) => [
        { type: "Message", id: `CHAT_${chatId}` },
      ],
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
      invalidatesTags: (_r, _e, { chatId }) => [
        { type: "Message", id: `CHAT_${chatId}` },
        { type: "Message", id: "CROSS" },
        { type: "Chat", id: chatId },
        { type: "Chat", id: "LIST" },
      ],
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
      invalidatesTags: (_r, _e, { chatId }) => [
        { type: "Message", id: `CHAT_${chatId}` },
        { type: "Message", id: "CROSS" },
      ],
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
        fd.append("file", file, file.name);
        if (subpath) fd.append("subpath", subpath);
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
      { q: string; scope?: "chats" | "artifacts" | "library" | "all" }
    >({
      query: ({ q, scope }) => {
        const p = new URLSearchParams({ q });
        if (scope) p.set("scope", scope);
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
