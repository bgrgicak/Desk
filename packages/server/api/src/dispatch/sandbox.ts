import { type IncomingMessage, type ServerResponse } from "node:http";
import { queries } from "@agent-desk/db";
import { generateId, NotFoundError, ValidationError } from "@agent-desk/shared";
import { authenticateSandboxToken } from "../auth/sandboxToken.js";
import { requireOwnedChat } from "../auth/ownership.js";
import * as chatRoutes from "../routes/chats.js";
import * as searchRoutes from "../routes/search.js";
import * as vaultRoutes from "../routes/vault.js";
import { parseBody, sendJson } from "../http/io.js";
import { parseSearchKinds, parseSearchScope } from "../routes/search-params.js";
import {
  findDuplicateScheduledSandboxTask,
  sandboxSessionRunsScheduledTask,
} from "../routes/sandbox-task-helpers.js";
import type { DispatchContext } from "./context.js";

/**
 * Dispatcher for every `/sandbox/*` route. All sandbox routes share the
 * `X-Desk-Sandbox-Token` auth scheme (`authenticateSandboxToken`) and
 * never see the regular bearer-session middleware — so they sit BEFORE
 * `requireAuth` in the main dispatcher chain.
 *
 * Returns `true` when the request was handled (response written), `false`
 * when the path doesn't match any /sandbox/* route the caller should
 * keep trying later branches.
 */
export async function dispatchSandbox(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  segments: string[],
  ctx: DispatchContext,
): Promise<boolean> {
  const { pool, vault, storage, runManager, emit } = ctx;

  if (path === "/sandbox/secrets" && method === "GET") {
    const tokenHeader = req.headers["x-desk-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const { agent } = await authenticateSandboxToken(pool, token);
    const result = vaultRoutes.sandboxList(vault, agent.userId);
    sendJson(res, 200, result);
    return true;
  }

  if (segments[0] === "sandbox" && segments[1] === "secrets" && segments.length === 3 && method === "GET") {
    const tokenHeader = req.headers["x-desk-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const { agent } = await authenticateSandboxToken(pool, token);
    const title = decodeURIComponent(segments[2]);
    const result = vaultRoutes.sandboxGet(vault, agent.userId, title);
    if (!result) {
      sendJson(res, 404, { code: "NOT_FOUND", message: "No such secret" });
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }

  if (path === "/sandbox/messages" && method === "POST") {
    const tokenHeader = req.headers["x-desk-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const { session, agent } = await authenticateSandboxToken(pool, token);
    const body = await parseBody(req) as { chatId?: string; newChat?: boolean; title?: unknown; content?: unknown; executeAt?: unknown; cron?: unknown } & Record<string, unknown>;
    if (!body.chatId || typeof body.chatId !== "string") {
      throw new ValidationError("Missing chatId");
    }
    const sourceChatId = body.chatId;
    await requireOwnedChat(pool, sourceChatId, agent.userId);
    let targetChatId = sourceChatId;
    let createdChat: unknown;

    const sendBody = { kind: "task", ...body };
    delete (sendBody as { chatId?: string }).chatId;
    delete (sendBody as { newChat?: boolean }).newChat;

    const attachments = (sendBody as { attachments?: unknown }).attachments;
    if (Array.isArray(attachments)) {
      for (const attachment of attachments) {
        const attachmentPath = (attachment as { path?: unknown })?.path;
        if (typeof attachmentPath !== "string" || !attachmentPath.trim()) {
          throw new ValidationError("Invalid attachment path");
        }
        if (attachmentPath.includes("\0") || attachmentPath.includes("\\") || attachmentPath.startsWith("/")) {
          throw new ValidationError(`Invalid attachment path: ${attachmentPath}`);
        }
        const pathSegments = attachmentPath.split("/");
        if (pathSegments.some((segment) => segment === "" || segment === "." || segment === "..")) {
          throw new ValidationError(`Invalid attachment path: ${attachmentPath}`);
        }
        if (attachmentPath.startsWith(".chats/") && !attachmentPath.startsWith(`.chats/${sourceChatId}/artifacts/`)) {
          throw new ValidationError("Sandbox task attachments must be library files or artifacts from the source chat");
        }
      }
    }

    if (body.newChat === true) {
      if (typeof body.executeAt === "string" || typeof body.cron === "string") {
        throw new ValidationError("newChat is only for simple manual tasks; scheduled and recurring tasks must stay in their existing task chat");
      }
      if (typeof body.kind === "string" && body.kind !== "task") {
        throw new ValidationError("newChat is only for simple manual tasks; kind must be omitted or task");
      }
      sendBody.kind = "task";
      const sourceChat = await chatRoutes.getChat(pool, sourceChatId);
      const rawTitle = typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined;
      const rawContent = typeof body.content === "string" ? body.content.trim() : "";
      if (typeof body.content === "string" && !body.content.includes(sourceChatId)) {
        sendBody.content = `${body.content}\n\nOriginating chat: ${sourceChatId}`;
      }
      chatRoutes.validateSendMessageBody(sendBody);
      createdChat = await chatRoutes.createChat(pool, {
        workspaceId: sourceChat.workspaceId,
        agentId: sourceChat.agentId,
        title: rawTitle ?? (rawContent.slice(0, 80) || "New task"),
        goal: "task",
      });
      targetChatId = (createdChat as { id: string }).id;
    }

    // Default kind = "task" for sandbox-issued messages: the agent calls
    // this from `desk-agent task schedule`, so a chat reply isn't the intent.
    // Caller can still override (e.g. kind="summary") if they have a
    // reason to.
    if (!createdChat) chatRoutes.validateSendMessageBody(sendBody);

    if (
      !createdChat &&
      await sandboxSessionRunsScheduledTask(pool, session.runId) &&
      ((typeof sendBody.executeAt === "string" && sendBody.executeAt.trim()) || (typeof sendBody.cron === "string" && sendBody.cron.trim())) &&
      (sendBody.kind === undefined || sendBody.kind === "task") &&
      typeof sendBody.content === "string"
    ) {
      const duplicate = await findDuplicateScheduledSandboxTask(pool, {
        userId: agent.userId,
        chatId: targetChatId,
        title: typeof sendBody.title === "string" && sendBody.title.trim() ? sendBody.title.trim() : undefined,
        content: sendBody.content,
        executeAt: typeof sendBody.executeAt === "string" ? sendBody.executeAt : undefined,
        cron: typeof sendBody.cron === "string" ? sendBody.cron : undefined,
      });
      if (duplicate) {
        sendJson(res, 200, duplicate);
        return true;
      }
    }

    const { userMessage } = await chatRoutes.sendMessage(pool, targetChatId, sendBody, emit, { role: "agent" });
    sendJson(res, 201, createdChat ? { chat: createdChat, message: userMessage } : userMessage);
    return true;
  }

  // Sandbox task cancellation — lets an agent cancel follow-up checks it
  // previously scheduled without needing a browser user-session token.
  if (path === "/sandbox/messages/cancel" && method === "POST") {
    const tokenHeader = req.headers["x-desk-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const { agent } = await authenticateSandboxToken(pool, token);
    const body = await parseBody(req) as { chatId?: unknown; messageId?: unknown };
    if (typeof body.chatId !== "string" || !body.chatId) {
      throw new ValidationError("Missing chatId");
    }
    if (typeof body.messageId !== "string" || !body.messageId) {
      throw new ValidationError("Missing messageId");
    }

    await requireOwnedChat(pool, body.chatId, agent.userId);
    const current = await queries.messages.findById(pool, body.messageId);
    if (!current || current.chatId !== body.chatId) {
      throw new NotFoundError(`Message not found in chat: ${body.messageId}`);
    }
    if (current.kind !== "task") {
      throw new ValidationError("Only task messages can be cancelled via the sandbox task API");
    }

    const updated = await chatRoutes.patchMessage(
      pool,
      storage,
      body.chatId,
      body.messageId,
      { state: "cancelled" },
      emit,
      runManager,
    );
    sendJson(res, 200, updated);
    return true;
  }

  // Seed messages — bulk-inserts text messages without triggering agent
  // turns. Used by the agent to populate a chat for scrollback testing.
  if (path === "/sandbox/seed-messages" && method === "POST") {
    const tokenHeader = req.headers["x-desk-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const { agent } = await authenticateSandboxToken(pool, token);
    const body = await parseBody(req) as {
      chatId?: string;
      messages?: Array<{ role?: string; text: string }>;
    };
    if (!body.chatId || typeof body.chatId !== "string") {
      throw new ValidationError("Missing chatId");
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw new ValidationError("Missing or empty messages array");
    }
    await requireOwnedChat(pool, body.chatId, agent.userId);

    const inserted: unknown[] = [];
    for (const m of body.messages) {
      const role = m.role === "agent" ? "agent" : "user";
      const msg = await queries.messages.insert(pool, {
        id: generateId("message"),
        chatId: body.chatId,
        role,
        content: { type: "text", text: m.text },
      });
      inserted.push(msg);
    }
    sendJson(res, 201, { count: inserted.length });
    return true;
  }

  // Memory-system P3.5 — full-text search for the in-sandbox agent.
  // Auth is X-Desk-Sandbox-Token. Recall is scoped to the sandbox
  // session's workspace by default; the hub session widens to all
  // workspaces the user owns (scope.kind === 'owned').
  if (path === "/sandbox/search/messages" && method === "GET") {
    const tokenHeader = req.headers["x-desk-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const { session, agent, workspace, scope } = await authenticateSandboxToken(pool, token);
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const q = params.get("q") ?? params.get("query") ?? "";
    const chatIdParam = params.get("chat") ?? undefined;
    const workspaceParam = params.get("workspace") ?? undefined;
    const kindParam = params.get("kind") ?? "any";
    const limitParam = Number.parseInt(params.get("limit") ?? "25", 10);

    if (!session.workspaceId || !workspace) {
      throw new NotFoundError("Workspace not found for sandbox session");
    }
    if (workspace.userId !== agent.userId) {
      throw new NotFoundError(`Workspace not found: ${session.workspaceId}`);
    }
    // For non-hub sessions, the workspace param must match the session
    // workspace (or `*`). Hub sessions accept any owned workspace's
    // slug or id; the search routes themselves still enforce
    // `user_id` equality so leakage is impossible.
    let workspaceSlugFilter: string | undefined = workspace.path;
    let workspaceSlugsFilter: string[] | undefined;
    if (workspaceParam && workspaceParam !== "*") {
      if (scope.kind === "owned") {
        const owned = await queries.workspaces.listByUser(pool, agent.userId);
        const match = owned.find(
          (w) => w.path === workspaceParam || w.id === workspaceParam,
        );
        if (!match) throw new NotFoundError(`Workspace not found: ${workspaceParam}`);
        workspaceSlugFilter = match.path;
      } else if (workspaceParam !== workspace.path) {
        throw new NotFoundError(`Workspace not found: ${workspaceParam}`);
      }
    } else if (workspaceParam === "*" || scope.kind === "owned") {
      // Hub sessions (scope.kind === "owned") default to all owned workspaces,
      // whether or not workspace=* is explicit. Project sessions that pass
      // workspace=* enter this branch but the inner guard is false — they fall
      // through with workspaceSlugFilter unchanged (session workspace only).
      // This is correct: project tokens cannot broaden beyond their workspace.
      if (scope.kind === "owned") {
        const owned = await queries.workspaces.listByUser(pool, agent.userId);
        workspaceSlugsFilter = owned.map((w) => w.path);
        workspaceSlugFilter = undefined;
      }
    }

    // When chatId is supplied, gate ownership.
    if (chatIdParam) {
      const chat = await requireOwnedChat(pool, chatIdParam, agent.userId);
      if (scope.kind === "single" && chat.workspaceId !== session.workspaceId) {
        throw new NotFoundError(`Chat not found: ${chatIdParam}`);
      }
    }

    const hits = await queries.search.searchChatMessages(pool, {
      query: q,
      chatId: chatIdParam,
      ...(workspaceSlugsFilter ? { workspaceSlugs: workspaceSlugsFilter } : { workspaceSlug: workspaceSlugFilter ?? workspace.path }),
      kind: kindParam === "message" || kindParam === "summary" ? kindParam : "any",
      limit: Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 25,
    });

    sendJson(res, 200, { hits });
    return true;
  }

  if (path === "/sandbox/search" && method === "GET") {
    const tokenHeader = req.headers["x-desk-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const { session, agent, scope } = await authenticateSandboxToken(pool, token);
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const q = params.get("q") ?? params.get("query") ?? "";
    const workspaceParam = params.get("workspace") ?? undefined;
    const ownedWorkspaces = await queries.workspaces.listByUser(pool, agent.userId);
    if (!session.workspaceId) {
      throw new NotFoundError("Workspace not found for sandbox session");
    }
    const sessionWorkspace = ownedWorkspaces.find((w) => w.id === session.workspaceId);
    if (!sessionWorkspace) {
      throw new NotFoundError(`Workspace not found: ${session.workspaceId}`);
    }
    // Resolve the search workspace. Hub sessions can target any owned
    // workspace via path or id, or omit the param to search the
    // session workspace; project sessions can only target their own.
    let resolvedWorkspace = sessionWorkspace;
    if (workspaceParam && workspaceParam !== "*") {
      if (scope.kind === "owned") {
        const match = ownedWorkspaces.find(
          (w) => w.path === workspaceParam || w.id === workspaceParam,
        );
        if (!match) throw new NotFoundError(`Workspace not found: ${workspaceParam}`);
        resolvedWorkspace = match;
      } else if (
        workspaceParam !== sessionWorkspace.path &&
        workspaceParam !== sessionWorkspace.id
      ) {
        throw new NotFoundError(`Workspace not found: ${workspaceParam}`);
      }
    }
    const result = await searchRoutes.search(
      pool,
      storage,
      agent.userId,
      q,
      parseSearchScope(params.get("scope")),
      {
        workspaceId: resolvedWorkspace.id,
        chatId: params.get("chatId") ?? params.get("chat") ?? undefined,
        kinds: parseSearchKinds(params.get("kind")),
        showHidden: params.get("showHidden") === "true",
      },
    );
    sendJson(res, 200, { hits: result });
    return true;
  }

  if ((path === "/sandbox/find/library" || path === "/sandbox/find/artifacts") && method === "GET") {
    const tokenHeader = req.headers["x-desk-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const { session, agent, scope } = await authenticateSandboxToken(pool, token);
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const workspaceParam = params.get("workspace") ?? undefined;
    const ownedWorkspaces = await queries.workspaces.listByUser(pool, agent.userId);
    if (!session.workspaceId) {
      throw new NotFoundError("Workspace not found for sandbox session");
    }
    const sessionWorkspace = ownedWorkspaces.find((w) => w.id === session.workspaceId);
    if (!sessionWorkspace) {
      throw new NotFoundError(`Workspace not found: ${session.workspaceId}`);
    }
    let resolvedWorkspace = sessionWorkspace;
    if (workspaceParam && workspaceParam !== "*") {
      if (scope.kind === "owned") {
        const match = ownedWorkspaces.find(
          (w) => w.path === workspaceParam || w.id === workspaceParam,
        );
        if (!match) throw new NotFoundError(`Workspace not found: ${workspaceParam}`);
        resolvedWorkspace = match;
      } else if (
        workspaceParam !== sessionWorkspace.path &&
        workspaceParam !== sessionWorkspace.id
      ) {
        throw new NotFoundError(`Workspace not found: ${workspaceParam}`);
      }
    }
    const kindParam = params.get("kind") ?? "any";
    const limitParam = Number.parseInt(params.get("limit") ?? "25", 10);
    const result = await searchRoutes.findLibraryItems(pool, storage, agent.userId, {
      query: params.get("q") ?? params.get("query") ?? undefined,
      kind:
        kindParam === "app" || kindParam === "fragment" || kindParam === "note" || kindParam === "doc"
          ? kindParam
          : "any",
      workspaceId: resolvedWorkspace.id,
      limit: Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 25,
    });
    sendJson(res, 200, { hits: result });
    return true;
  }

  if (path === "/sandbox/artifacts" && method === "POST") {
    const tokenHeader = req.headers["x-desk-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const { session, agent } = await authenticateSandboxToken(pool, token);
    const body = await parseBody(req) as { chatId?: string } & Record<string, unknown>;
    if (!session.runId) {
      throw new ValidationError("Sandbox artifact attachment requires a live run token");
    }
    const runMessage = await queries.messages.findById(pool, session.runId);
    if (!runMessage) {
      throw new ValidationError("Sandbox run is no longer active");
    }
    if (runMessage.state !== "running") {
      throw new ValidationError("Sandbox run is no longer active");
    }
    const runChatId = runMessage.chatId;
    if (body.chatId !== undefined && (typeof body.chatId !== "string" || body.chatId !== runChatId)) {
      throw new ValidationError("Sandbox runs can only attach artifacts to their own chat");
    }
    if (runMessage.kind === "summary" || runMessage.content.type === "summary_request") {
      throw new ValidationError("Summary runs cannot attach artifacts");
    }
    const chat = await requireOwnedChat(pool, runChatId, agent.userId);
    if (session.workspaceId && chat.workspaceId !== session.workspaceId) {
      throw new NotFoundError(`Chat not found: ${runChatId}`);
    }

    const message = await chatRoutes.attachArtifactRef(storage, { ...body, chatId: runChatId }, emit, {
      agentId: agent.id,
      model: agent.model,
    });
    sendJson(res, 201, message);
    return true;
  }

  return false;
}
