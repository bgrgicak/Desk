import { type IncomingMessage, type ServerResponse } from "node:http";
import { queries } from "@roomy-ai/db";
import { generateId, NotFoundError, ValidationError, type Agent, type Chat, type Message, type SandboxSession } from "@roomy-ai/shared";
import { withModule } from "@roomy-ai/shared/logger";
import { authenticateSandboxToken } from "../auth/sandboxToken.js";
import { requireOwnedChat } from "../auth/ownership.js";
import * as chatRoutes from "../routes/chats.js";
import * as searchRoutes from "../routes/search.js";
import * as vaultRoutes from "../routes/vault.js";
import { parseBody, sendJson } from "../http/io.js";
import { parseSearchKinds, parseSearchScope } from "../routes/search-params.js";
import type { DispatchContext } from "./context.js";
import type { WorkspaceScope } from "../workspace-scope.js";

const log = withModule("api/dispatch/sandbox");

interface CurrentTaskContext {
  task: Message;
  run: Message | null;
  threadChatId: string;
}

interface SandboxRouteAuth {
  agent: Agent;
  session: SandboxSession;
  scope: WorkspaceScope;
}

async function currentTaskFromSession(
  pool: DispatchContext["pool"],
  session: SandboxSession,
): Promise<CurrentTaskContext | null> {
  if (!session.runId) return null;
  const run = await queries.messages.findById(pool, session.runId);
  if (!run || run.kind !== "task_run" || !run.parentId) return null;
  const task = await queries.messages.findById(pool, run.parentId);
  if (!task || task.kind !== "task") return null;
  return {
    task,
    run,
    threadChatId: run.chatId || task.threadChatId || task.chatId,
  };
}

async function requireSandboxScopedChat(
  pool: DispatchContext["pool"],
  chatId: string,
  auth: SandboxRouteAuth,
): Promise<Chat> {
  const chat = await requireOwnedChat(pool, chatId, auth.agent.userId);
  if (chat.workspaceId !== auth.session.workspaceId) {
    throw new NotFoundError(`Chat not found: ${chatId}`);
  }
  return chat;
}

async function taskByIdForAgent(
  pool: DispatchContext["pool"],
  taskId: string,
  auth: SandboxRouteAuth,
): Promise<Message> {
  const task = await queries.messages.findById(pool, taskId);
  if (!task) throw new NotFoundError(`Task not found: ${taskId}`);
  await requireSandboxScopedChat(pool, task.chatId, auth);
  if (task.kind !== "task") {
    throw new ValidationError(`Message ${task.id} is not a task (kind=${task.kind})`);
  }
  return task;
}

async function resolveCurrentTaskOrThrow(
  pool: DispatchContext["pool"],
  auth: SandboxRouteAuth,
): Promise<CurrentTaskContext> {
  const ctx = await currentTaskFromSession(pool, auth.session);
  if (!ctx) {
    throw new ValidationError("No current task in this sandbox session; pass an explicit task id or run from a task");
  }
  await requireSandboxScopedChat(pool, ctx.task.chatId, auth);
  if (ctx.threadChatId !== ctx.task.chatId) {
    await requireSandboxScopedChat(pool, ctx.threadChatId, auth);
  }
  return ctx;
}

/**
 * Dispatcher for every `/sandbox/*` route. All sandbox routes share the
 * `X-Roomy-Sandbox-Token` auth scheme (`authenticateSandboxToken`) and
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
    const tokenHeader = req.headers["x-roomy-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const { agent } = await authenticateSandboxToken(pool, token);
    const result = vaultRoutes.sandboxList(vault, agent.userId);
    sendJson(res, 200, result);
    return true;
  }

  if (segments[0] === "sandbox" && segments[1] === "secrets" && segments.length === 3 && method === "GET") {
    const tokenHeader = req.headers["x-roomy-sandbox-token"];
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
    const tokenHeader = req.headers["x-roomy-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const auth = await authenticateSandboxToken(pool, token);
    const body = await parseBody(req) as { chatId?: string; newChat?: boolean; title?: unknown; content?: unknown; executeAt?: unknown; cron?: unknown; parentTaskId?: unknown } & Record<string, unknown>;
    let parentTask: Message | null = null;
    if (typeof body.parentTaskId === "string" && body.parentTaskId) {
      parentTask = await taskByIdForAgent(pool, body.parentTaskId, auth);
    } else if (!body.chatId) {
      parentTask = (await resolveCurrentTaskOrThrow(pool, auth)).task;
    }

    const sourceChatId = parentTask
      ? parentTask.threadChatId ?? parentTask.chatId
      : body.chatId;
    if (!sourceChatId || typeof sourceChatId !== "string") {
      throw new ValidationError("Missing chatId or parentTaskId");
    }
    await requireSandboxScopedChat(pool, sourceChatId, auth);

    const sendBody = { kind: "task", ...body };
    delete (sendBody as { chatId?: string }).chatId;
    delete (sendBody as { parentTaskId?: unknown }).parentTaskId;
    // `newChat` is accepted but ignored — task creation now always spawns
    // a thread off the source chat. Field kept on the wire for older
    // callers; the legacy "peer chat at workspace level" mode is gone.
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

    const isTask = (sendBody.kind ?? "task") === "task";
    chatRoutes.validateSendMessageBody(sendBody);

    if (!isTask) {
      // Non-task kinds (e.g. `summary`) post into the source chat — they
      // are not standalone work items the user navigates to from the
      // tasks list, so the thread model does not apply.
      const { userMessage } = await chatRoutes.sendMessage(pool, sourceChatId, sendBody, emit, { role: "agent" });
      sendJson(res, 201, userMessage);
      return true;
    }

    // Task model: the task message is posted in the source chat as the
    // thread anchor (kind='task', carries the schedule + state). A
    // dedicated thread chat is created and linked via thread_chat_id —
    // task_runs and follow-up replies land there, not in the source chat.
    // Clicking the task in the tasks list opens this thread; the source
    // chat shows the anchor inline with an "open thread" affordance.
    const { userMessage: anchorMessage } = await chatRoutes.sendMessage(
      pool, sourceChatId, sendBody, emit, { role: "agent", parentId: parentTask?.id ?? null },
    );
    const threadChat = await chatRoutes.createThreadShell(
      pool, sourceChatId, anchorMessage, emit,
    );

    // Auto-fire policy for sandbox-issued tasks:
    //   - executeAt or cron present → scheduler fires when due. Leave it.
    //   - Neither → unscheduled task. The agent's intent in spinning this
    //     off is "go do this now"; the card must land on the board as
    //     Active and stay Active until either the agent calls
    //     `task complete` or the run propagates a terminal state via
    //     afterTaskRun. Two things make that work:
    //       1. Insert the task_run row synchronously so the HTTP response
    //          reflects an active state immediately (the rich status
    //          selector reads a running task_run as Active — without the
    //          sync insert there's a perceptible Todo window).
    //       2. Flip the parent task's state from `pending` to `running`
    //          so Active sticks across the run-terminate gap. Without
    //          this, when the run finishes the parent falls through the
    //          status selector to `todo` (the "Open" badge) because no
    //          run is in-flight and no schedule is set. With it, the
    //          parent state itself reads as Active; afterTaskRun then
    //          mirrors the run's terminal state onto the parent so the
    //          user eventually sees Done / Failed instead of stale Active.
    //     The user-facing TasksPage composer still has explicit
    //     todo/active control via the kanban; only this agent path
    //     defaults to running because there is no UI for the agent to
    //     choose a column.
    const hasSchedule =
      (typeof anchorMessage.executeAt === "string" && anchorMessage.executeAt.length > 0) ||
      (typeof anchorMessage.cron === "string" && anchorMessage.cron.length > 0);
    let preStartedRun: Awaited<ReturnType<typeof runManager.beginTaskRun>> = null;
    let activeAnchor = anchorMessage;
    if (!hasSchedule) {
      preStartedRun = await runManager.beginTaskRun(anchorMessage.id);
      if (!preStartedRun) {
        // beginTaskRun returns null only when the message is missing,
        // not a task, or another run is already in flight. The first
        // two are caller bugs; the last is a benign race with the
        // scheduler. Fall back to the regular fireMessage path, which
        // hits the same in-flight guard and is safe.
        log.warn(
          { messageId: anchorMessage.id, chatId: sourceChatId },
          "beginTaskRun returned null — falling back to fireMessage",
        );
      } else {
        // Mirror the run-in-flight state on the parent so the kanban
        // badge stays Active past the moment the task_run terminates.
        // Guarded to `pending` so a concurrent user gesture that already
        // moved the anchor (cancel, etc.) wins.
        const promoted = await queries.messages.updateMessageIfState(
          pool,
          anchorMessage.id,
          { state: "running" },
          ["pending"],
        );
        if (promoted) {
          activeAnchor = promoted;
          emit({ type: "message.updated", payload: promoted });
        }
      }
      runManager
        .fireMessage(anchorMessage.id, preStartedRun ? { preStartedRunId: preStartedRun.id } : {})
        .catch((err: unknown) => {
          log.error(
            { messageId: anchorMessage.id, chatId: sourceChatId, err },
            "auto-fire of unscheduled task failed",
          );
        });
    }

    // createThreadShell sets thread_chat_id on the anchor row; reflect
    // that on the response so callers don't have to round-trip.
    sendJson(res, 201, {
      message: { ...activeAnchor, threadChatId: threadChat.id },
      threadChat,
      parentChatId: sourceChatId,
      run: preStartedRun ?? undefined,
    });
    return true;
  }

  // Sandbox task reschedule — modify an existing task's schedule (and
  // optionally title/content) in place. The agent uses this when the user
  // asks to change/move/delay an existing task. Strictly an UPDATE on the
  // existing row: same id, same created_at, just a new fire time and
  // state reset to pending. Refuses the call when no schedule is supplied
  // so the agent can't silently turn a scheduled task into a manual one
  // by forgetting --at.
  if (path === "/sandbox/messages/reschedule" && method === "POST") {
    const tokenHeader = req.headers["x-roomy-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const auth = await authenticateSandboxToken(pool, token);
    const body = await parseBody(req) as {
      chatId?: unknown;
      messageId?: unknown;
      executeAt?: unknown;
      cron?: unknown;
      title?: unknown;
      content?: unknown;
    };
    if (typeof body.chatId !== "string" || !body.chatId) {
      throw new ValidationError("Missing chatId");
    }
    if (typeof body.messageId !== "string" || !body.messageId) {
      throw new ValidationError("Missing messageId");
    }
    const hasAt = typeof body.executeAt === "string" && body.executeAt.trim().length > 0;
    const hasCron = typeof body.cron === "string" && body.cron.trim().length > 0;
    if (hasAt && hasCron) {
      throw new ValidationError("executeAt and cron are mutually exclusive");
    }
    if (!hasAt && !hasCron) {
      throw new ValidationError(
        "reschedule requires executeAt or cron; use /sandbox/messages/cancel to stop a task entirely",
      );
    }

    await requireSandboxScopedChat(pool, body.chatId, auth);
    const current = await queries.messages.findById(pool, body.messageId);
    if (!current || current.chatId !== body.chatId) {
      throw new NotFoundError(`Message not found in chat: ${body.messageId}`);
    }
    if (current.kind !== "task") {
      throw new ValidationError("Only task messages can be rescheduled via the sandbox task API");
    }

    // executeAt and cron are mutually exclusive on the row, so when the
    // caller swaps from one to the other we have to clear the unused field.
    const patch: { state: "pending"; executeAt?: string | null; cron?: string | null; title?: string; content?: { type: "text"; text: string } } = {
      state: "pending",
    };
    if (hasAt) {
      patch.executeAt = (body.executeAt as string).trim();
      patch.cron = null;
    } else {
      patch.cron = (body.cron as string).trim();
      patch.executeAt = null;
    }
    if (typeof body.title === "string") {
      const trimmed = body.title.trim();
      if (!trimmed) throw new ValidationError("title cannot be empty");
      patch.title = trimmed;
    }
    if (typeof body.content === "string") {
      patch.content = { type: "text", text: body.content };
    }

    const updated = await chatRoutes.patchMessage(
      pool,
      storage,
      body.chatId,
      body.messageId,
      patch,
      emit,
      runManager,
    );
    sendJson(res, 200, updated);
    return true;
  }

  // Sandbox task completion — marks a task done AND optionally delivers a
  // result message back to the parent chat in one call. This is the
  // "I'm finished with this side job, here's what I did" verb.
  //
  // Two ways to identify the task:
  //   - `messageId`: the task anchor's id. Use this when the agent isn't
  //     sitting inside the task's thread chat (e.g. completing from the
  //     source chat, or from an unrelated interactive run that has the
  //     anchor id in context).
  //   - `chatId`: the task's dedicated thread chat id. The server walks
  //     back to the anchor via `thread_chat_id`. This is the path the
  //     agent uses when it IS inside the thread.
  // Exactly one of the two is required; if both are supplied, `messageId`
  // wins and the chatId is ignored.
  //
  // Recurring (cron) tasks are rejected — they're not the right shape
  // for "complete" (use cancel to stop a recurring task entirely).
  //
  // When `message` is supplied, it's posted as a `role='agent'`
  // `kind='chat'` message in the *parent* chat, with `parentId` pointing
  // at the task anchor — so the UI can render it next to the task and
  // the user / main-thread agent sees the outcome without opening the
  // sub-task thread.
  if (path === "/sandbox/messages/complete" && method === "POST") {
    const tokenHeader = req.headers["x-roomy-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const auth = await authenticateSandboxToken(pool, token);
    const { session } = auth;
    const body = await parseBody(req) as { chatId?: unknown; messageId?: unknown; message?: unknown };
    const messageIdArg = typeof body.messageId === "string" && body.messageId ? body.messageId : null;
    const chatIdArg = typeof body.chatId === "string" && body.chatId ? body.chatId : null;
    if (!messageIdArg && !chatIdArg) {
      const current = await resolveCurrentTaskOrThrow(pool, auth);
      body.messageId = current.task.id;
    }

    const anchor = await (async () => {
      const currentMessageId = typeof body.messageId === "string" && body.messageId ? body.messageId : messageIdArg;
      if (currentMessageId) {
        const found = await queries.messages.findById(pool, currentMessageId);
        if (!found) {
          throw new NotFoundError(`Task not found: ${currentMessageId}`);
        }
        await requireSandboxScopedChat(pool, found.chatId, auth);
        return found;
      }
      if (messageIdArg) {
        const found = await queries.messages.findById(pool, messageIdArg);
        if (!found) {
          throw new NotFoundError(`Task not found: ${messageIdArg}`);
        }
        // Validate ownership via the anchor's own chat — the agent must own
        // the chat the task lives in, not whatever chat it's calling from.
        await requireSandboxScopedChat(pool, found.chatId, auth);
        return found;
      }
      const threadChatId = chatIdArg!;
      await requireSandboxScopedChat(pool, threadChatId, auth);
      const found = await queries.messages.findAnchorForThreadChat(pool, threadChatId);
      if (!found) {
        throw new NotFoundError(
          `No task anchor for chat: ${threadChatId} — pass messageId to complete a task from outside its thread`,
        );
      }
      return found;
    })();
    if (anchor.kind !== "task") {
      throw new ValidationError(
        `Message ${anchor.id} is not a task (kind=${anchor.kind}); task complete is for tasks only`,
      );
    }
    if (anchor.cron && anchor.cron.trim().length > 0) {
      throw new ValidationError(
        "Recurring tasks cannot be marked complete — use /sandbox/messages/cancel to stop the task entirely",
      );
    }
    if (anchor.state === "succeeded" || anchor.state === "cancelled" || anchor.state === "failed") {
      throw new ValidationError(
        `Task is already in terminal state (${anchor.state}); cannot mark complete again`,
      );
    }

    let updatedAnchor = anchor;
    const transitioned = await queries.messages.updateMessage(pool, anchor.id, {
      state: "succeeded",
      executeAt: null,
    });
    if (transitioned) {
      updatedAnchor = transitioned;
      emit({ type: "message.updated", payload: transitioned });
    }
    const current = await currentTaskFromSession(pool, session);
    let updatedRun: Message | null = null;
    if (current?.run && current.task.id === anchor.id) {
      updatedRun = await queries.messages.finalizeExecution(pool, current.run.id, "succeeded");
      if (updatedRun) emit({ type: "message.updated", payload: updatedRun });
    }

    let report: typeof anchor | undefined;
    const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
    if (rawMessage.length > 0) {
      const noteId = generateId("message");
      report = await queries.messages.insert(pool, {
        id: noteId,
        chatId: anchor.chatId,
        role: "agent",
        content: { type: "text", text: rawMessage },
        parentId: anchor.id,
        agentId: anchor.agentId ?? null,
      });
      const { rows: parentChatRows } = await pool.query<{ workspace_id: string; title: string | null }>(
        `SELECT workspace_id, title FROM chats WHERE id = ?`,
        [anchor.chatId],
      );
      emit({
        type: "message.appended",
        payload: report,
        workspaceId: parentChatRows[0]?.workspace_id,
        chatTitle: parentChatRows[0]?.title ?? undefined,
      });
    }

    sendJson(res, 200, { task: updatedAnchor, run: updatedRun ?? undefined, report, parentChatId: anchor.chatId });
    return true;
  }

  if (path === "/sandbox/tasks/progress" && method === "POST") {
    const tokenHeader = req.headers["x-roomy-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const auth = await authenticateSandboxToken(pool, token);
    const { agent } = auth;
    const body = await parseBody(req) as { message?: unknown };
    const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
    if (!rawMessage) throw new ValidationError("Missing progress message");
    const current = await resolveCurrentTaskOrThrow(pool, auth);
    const progress = await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId: current.threadChatId,
      role: "agent",
      content: { type: "text", text: rawMessage },
      parentId: current.run?.id ?? current.task.id,
      agentId: agent.id,
    });
    const chat = await queries.chats.findById(pool, current.threadChatId);
    emit({
      type: "message.appended",
      payload: progress,
      workspaceId: chat?.workspaceId,
      chatTitle: chat?.title,
    });
    sendJson(res, 201, { task: current.task, run: current.run ?? undefined, message: progress });
    return true;
  }

  if (path === "/sandbox/tasks/fail" && method === "POST") {
    const tokenHeader = req.headers["x-roomy-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const auth = await authenticateSandboxToken(pool, token);
    const { agent } = auth;
    const body = await parseBody(req) as { message?: unknown };
    const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
    if (!rawMessage) throw new ValidationError("Missing failure message");
    const current = await resolveCurrentTaskOrThrow(pool, auth);

    const updatedRun = current.run
      ? await queries.messages.finalizeExecution(pool, current.run.id, "failed") ?? await queries.messages.findById(pool, current.run.id)
      : null;
    if (updatedRun) emit({ type: "message.updated", payload: updatedRun });
    const updatedTask = await queries.messages.updateMessage(pool, current.task.id, { state: "failed" }) ?? current.task;
    emit({ type: "message.updated", payload: updatedTask });

    const report = await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId: current.threadChatId,
      role: "agent",
      content: { type: "text", text: rawMessage },
      parentId: current.run?.id ?? current.task.id,
      agentId: agent.id,
    });
    const chat = await queries.chats.findById(pool, current.threadChatId);
    emit({
      type: "message.appended",
      payload: report,
      workspaceId: chat?.workspaceId,
      chatTitle: chat?.title,
    });
    sendJson(res, 200, { task: updatedTask, run: updatedRun ?? undefined, report });
    return true;
  }

  // Sandbox task cancellation — lets an agent cancel follow-up checks it
  // previously scheduled without needing a browser user-session token.
  if (path === "/sandbox/messages/cancel" && method === "POST") {
    const tokenHeader = req.headers["x-roomy-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const auth = await authenticateSandboxToken(pool, token);
    const body = await parseBody(req) as { chatId?: unknown; messageId?: unknown };
    if (typeof body.chatId !== "string" || !body.chatId) {
      throw new ValidationError("Missing chatId");
    }
    if (typeof body.messageId !== "string" || !body.messageId) {
      throw new ValidationError("Missing messageId");
    }

    await requireSandboxScopedChat(pool, body.chatId, auth);
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
    const tokenHeader = req.headers["x-roomy-sandbox-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const auth = await authenticateSandboxToken(pool, token);
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
    await requireSandboxScopedChat(pool, body.chatId, auth);

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
  // Auth is X-Roomy-Sandbox-Token. Recall is scoped to the sandbox
  // session's workspace by default; the hub session widens to all
  // workspaces the user owns (scope.kind === 'owned').
  if (path === "/sandbox/search/messages" && method === "GET") {
    const tokenHeader = req.headers["x-roomy-sandbox-token"];
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
    const tokenHeader = req.headers["x-roomy-sandbox-token"];
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
    const tokenHeader = req.headers["x-roomy-sandbox-token"];
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
    const tokenHeader = req.headers["x-roomy-sandbox-token"];
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
    // Target chat defaults to the run's own chat, but the agent can also
    // surface artifacts in any other chat it owns within the same
    // workspace — e.g. a task thread or a sibling chat. The file path can
    // reference any chat in the workspace (the filesystem check below
    // catches paths that resolve outside the workspace tree).
    const targetChatId =
      typeof body.chatId === "string" && body.chatId.length > 0
        ? body.chatId
        : runChatId;
    if (body.chatId !== undefined && typeof body.chatId !== "string") {
      throw new ValidationError("chatId must be a string");
    }
    if (runMessage.kind === "summary" || runMessage.content.type === "summary_request") {
      throw new ValidationError("Summary runs cannot attach artifacts");
    }
    const chat = await requireOwnedChat(pool, targetChatId, agent.userId);
    if (session.workspaceId && chat.workspaceId !== session.workspaceId) {
      throw new NotFoundError(`Chat not found: ${targetChatId}`);
    }

    const message = await chatRoutes.attachArtifactRef(storage, { ...body, chatId: targetChatId }, emit, {
      agentId: agent.id,
      model: agent.model,
    });
    sendJson(res, 201, message);
    return true;
  }

  return false;
}
