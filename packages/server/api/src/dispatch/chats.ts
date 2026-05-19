import { type IncomingMessage, type ServerResponse } from "node:http";
import { ValidationError } from "@agent-desk/shared";
import { ReplaceLibraryAppConflictError } from "@agent-desk/storage";
import { withModule } from "@agent-desk/shared/logger";
import * as chatRoutes from "../routes/chats.js";
import {
  requireOwnedAgent,
  requireOwnedChat,
  requireOwnedMessage,
  requireOwnedWorkspace,
} from "../auth/ownership.js";
import { parseBody, sendJson } from "../http/io.js";
import { parseMultipart } from "../http/multipart.js";
import { resolveWorkspaceId } from "../workspace-scope.js";
import type { DispatchContext } from "./context.js";

const log = withModule("api/dispatch/chats");

/**
 * Dispatcher for the chat resource and every nested resource:
 *
 *   /chats (list, create)
 *   /chats/{id} (get, patch, delete)
 *   /chats/{id}/messages (list, send)
 *   /chats/{id}/messages/{mid} (patch, delete)
 *   /chats/{id}/messages/{mid}/{run|thread|summary-history|logs}
 *   /chats/{id}/attachments (list, delete)
 *   /chats/{id}/library-refs (pin a library file into the chat)
 *   /chats/{id}/save-to-library (promote attachment)
 *   /chats/{id}/copy-library-app, /chats/{id}/replace-library-app
 *   /chats/{id}/save-artifact-to-library
 *
 * Every branch is ownership-gated.  Returns true when handled.
 */
export async function dispatchChats(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  segments: string[],
  userId: string,
  query: URLSearchParams,
  ctx: DispatchContext,
): Promise<boolean> {
  const { pool, storage, runManager, emit } = ctx;

  if (path === "/chats" && method === "GET") {
    const wsId = await resolveWorkspaceId(pool, userId, query);
    const result = wsId ? await chatRoutes.listChats(pool, wsId) : [];
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "chats" && segments.length === 2 && method === "GET") {
    await requireOwnedChat(pool, segments[1], userId);
    const result = await chatRoutes.getChat(pool, segments[1]);
    sendJson(res, 200, result);
    return true;
  }
  if (path === "/chats" && method === "POST") {
    const body = await parseBody(req) as { workspaceId: string; agentId: string; title: string; goal?: string };
    await requireOwnedWorkspace(pool, body.workspaceId, userId);
    await requireOwnedAgent(pool, body.agentId, userId);
    const result = await chatRoutes.createChat(pool, body);
    sendJson(res, 201, result);
    return true;
  }
  if (segments[0] === "chats" && segments.length === 2 && method === "PATCH") {
    await requireOwnedChat(pool, segments[1], userId);
    const body = await parseBody(req) as { title?: string; goal?: string | null; agentId?: string; unread?: boolean };
    if (body.agentId !== undefined) {
      await requireOwnedAgent(pool, body.agentId, userId);
    }
    const result = await chatRoutes.patchChat(pool, segments[1], body);
    emit({ type: "chat.updated", payload: result });
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "chats" && segments.length === 2 && method === "DELETE") {
    await requireOwnedChat(pool, segments[1], userId);
    const result = await chatRoutes.deleteChat(
      pool,
      storage,
      segments[1],
      emit,
    );
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "chats" && segments[2] === "messages" && segments.length === 3 && method === "GET") {
    await requireOwnedChat(pool, segments[1], userId);
    const cursor = query.get("cursor") ?? undefined;
    const before = query.get("before") ?? undefined;
    const limitRaw = query.get("limit");
    let limit: number | undefined;
    if (limitRaw !== null && limitRaw !== "") {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new ValidationError(`Invalid limit: ${limitRaw}`);
      limit = Math.min(parsed, 200);
    }
    const viewRaw = query.get("view") ?? undefined;
    if (viewRaw !== undefined && viewRaw !== "full" && viewRaw !== "compact" && viewRaw !== "timeline") {
      throw new ValidationError(`Invalid view: ${viewRaw}`);
    }
    const result = await chatRoutes.listMessages(pool, segments[1], {
      cursor,
      before,
      limit,
      // Normal chat API reads should use the payload-trimmed timeline by
      // default. Full hidden tool/event/summary payloads remain available to
      // developer/debug callers that explicitly request `view=full`.
      view: (viewRaw ?? "timeline") as "full" | "compact" | "timeline",
    });
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "chats" && segments[2] === "messages" && segments.length === 3 && method === "POST") {
    await requireOwnedChat(pool, segments[1], userId);
    const ct = (req.headers["content-type"] ?? "").toLowerCase();
    const body = ct.startsWith("multipart/form-data")
      ? await chatRoutes.buildSendMessageBodyFromForm(storage, segments[1], await parseMultipart(req))
      : await parseBody(req);

    // If the previous agent_turn in this chat is hung (log file silent
    // for the stale window), preempt it so the user's follow-up isn't
    // racing a zombie opencode. Healthy runs — still emitting tokens,
    // tool calls, or step events — are left alone. Scheduled task or
    // summary sends never preempt: those are background work, not the
    // chat-level conversation the user is actively interacting with.
    const sendKind = (body as { kind?: string }).kind;
    if (!sendKind || sendKind === "chat") {
      await runManager.preemptStalledChatRun(segments[1]).catch((err: unknown) => {
        log.error({ chatId: segments[1], err }, "preempt for chat failed");
      });
    }

    const { userMessage, triggerId } = await chatRoutes.sendMessage(pool, segments[1], body, emit, { actorUserId: userId });

    // Self-firing kinds (task / summary): execute_at is computed at insert
    // time; the DB poll loop fires them when due. Unscheduled tasks just sit.
    if (userMessage.kind && userMessage.kind !== "chat") {
      sendJson(res, 201, userMessage);
      return true;
    }

    // Default chat path: fire the pending trigger message and schedule
    // a summary refresh for this chat.
    runManager.fireMessage(triggerId).catch((err) => {
      log.error({ err, triggerId }, "fireMessage for trigger failed");
    });
    runManager.scheduleSummary(segments[1]).catch(() => {});

    sendJson(res, 201, userMessage);
    return true;
  }
  if (segments[0] === "chats" && segments[2] === "messages" && segments[4] === "thread" && segments.length === 5 && method === "POST") {
    await requireOwnedMessage(pool, segments[1], segments[3], userId);
    const body = await parseBody(req);
    const result = await chatRoutes.createThread(pool, segments[1], segments[3], body, emit, { actorUserId: userId, userId });

    runManager.fireMessage(result.triggerId).catch((err) => {
      log.error({ err, triggerId: result.triggerId }, "fireMessage for thread trigger failed");
    });
    runManager.scheduleSummary(result.threadChat.id).catch(() => {});

    sendJson(res, 201, {
      chat: result.threadChat,
      message: result.threadStartMessage,
      anchorMessage: result.anchorMessage,
    });
    return true;
  }
  if (segments[0] === "chats" && segments[2] === "messages" && segments.length === 4 && method === "PATCH") {
    await requireOwnedMessage(pool, segments[1], segments[3], userId);
    const body = await parseBody(req) as { content?: unknown; state?: string; executeAt?: string | null; cron?: string | null; kind?: "chat" | "task" | "task_run" | "summary"; title?: string | null };
    const result = await chatRoutes.patchMessage(pool, storage, segments[1], segments[3], body, emit, runManager);
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "chats" && segments[2] === "messages" && segments[4] === "run" && segments.length === 5 && method === "POST") {
    await requireOwnedMessage(pool, segments[1], segments[3], userId);
    const result = await chatRoutes.runMessage(pool, segments[1], segments[3], runManager, emit);
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "chats" && segments[2] === "messages" && segments[4] === "summary-history" && segments.length === 5 && method === "GET") {
    await requireOwnedMessage(pool, segments[1], segments[3], userId);
    const result = await chatRoutes.getSummaryHistory(storage, segments[1], segments[3]);
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "chats" && segments[2] === "messages" && segments.length === 4 && method === "DELETE") {
    await requireOwnedMessage(pool, segments[1], segments[3], userId);
    await chatRoutes.deleteMessage(pool, storage, segments[1], segments[3]);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (segments[0] === "chats" && segments[2] === "messages" && segments[4] === "logs" && segments.length === 5 && method === "GET") {
    await requireOwnedMessage(pool, segments[1], segments[3], userId);
    const { stream, contentType } = await chatRoutes.getMessageLogs(storage, segments[1], segments[3]);
    res.writeHead(200, { "Content-Type": contentType });
    stream.pipe(res);
    return true;
  }
  if (segments[0] === "chats" && segments[2] === "attachments" && segments.length === 3 && method === "GET") {
    await requireOwnedChat(pool, segments[1], userId);
    const showHidden = query.get("showHidden") === "true";
    const includeArtifacts = query.get("includeArtifacts") === "true";
    const result = await chatRoutes.listAttachments(storage, segments[1], {
      showHidden,
      includeArtifacts,
    });
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "chats" && segments[2] === "attachments" && segments.length === 3 && method === "DELETE") {
    await requireOwnedChat(pool, segments[1], userId);
    const name = query.get("name") ?? "";
    if (!name) throw new ValidationError("Missing 'name' query parameter");
    const result = await chatRoutes.removeAttachment(storage, segments[1], name);
    sendJson(res, 200, result);
    return true;
  }
  if (segments[0] === "chats" && segments[2] === "library-refs" && segments.length === 3 && method === "POST") {
    await requireOwnedChat(pool, segments[1], userId);
    const body = (await parseBody(req)) as { path?: unknown };
    const libraryPath = typeof body?.path === "string" ? body.path : "";
    if (!libraryPath) {
      throw new ValidationError("Missing 'path' in body");
    }
    const result = await chatRoutes.pinLibraryFile(
      storage,
      segments[1],
      libraryPath,
      emit,
    );
    sendJson(res, 201, result);
    return true;
  }
  if (segments[0] === "chats" && segments[2] === "save-to-library" && segments.length === 3 && method === "POST") {
    await requireOwnedChat(pool, segments[1], userId);
    const body = (await parseBody(req)) as { name?: unknown; destSubpath?: unknown };
    const attachmentName = typeof body?.name === "string" ? body.name : "";
    if (!attachmentName) {
      throw new ValidationError("Missing 'name' in body");
    }
    const destSubpath =
      typeof body?.destSubpath === "string" && body.destSubpath.length > 0
        ? body.destSubpath
        : undefined;
    const result = await chatRoutes.saveAttachmentToLibrary(
      storage,
      segments[1],
      attachmentName,
      destSubpath,
      emit,
    );
    sendJson(res, 201, result);
    return true;
  }
  if (segments[0] === "chats" && segments[2] === "copy-library-app" && segments.length === 3 && method === "POST") {
    await requireOwnedChat(pool, segments[1], userId);
    const body = (await parseBody(req)) as { path?: unknown };
    const libraryPath = typeof body?.path === "string" ? body.path : "";
    if (!libraryPath) throw new ValidationError("Missing 'path' in body");
    const result = await chatRoutes.copyAppFromLibrary(
      storage,
      segments[1],
      libraryPath,
      emit,
    );
    sendJson(res, 201, result);
    return true;
  }
  if (segments[0] === "chats" && segments[2] === "replace-library-app" && segments.length === 3 && method === "POST") {
    await requireOwnedChat(pool, segments[1], userId);
    const body = (await parseBody(req)) as {
      name?: unknown;
      targetPath?: unknown;
      expectedSourceVersion?: unknown;
    };
    const artifactName = typeof body?.name === "string" ? body.name : "";
    const targetPath = typeof body?.targetPath === "string" ? body.targetPath : "";
    if (!artifactName) throw new ValidationError("Missing 'name' in body");
    if (!targetPath) throw new ValidationError("Missing 'targetPath' in body");
    // Canonical ETag semantics: `If-Match` header is the precondition.
    // Accept `body.expectedSourceVersion` as a fallback when the header
    // is absent (older clients) but never let the body override an
    // explicit header — two different values would otherwise silently
    // pick body and ignore the precondition.
    const headerIfMatch = req.headers["if-match"];
    const ifMatch = Array.isArray(headerIfMatch) ? headerIfMatch[0] : headerIfMatch;
    const expectedSourceVersion =
      typeof ifMatch === "string" && ifMatch
        ? ifMatch
        : typeof body?.expectedSourceVersion === "string"
          ? body.expectedSourceVersion
          : undefined;
    try {
      const result = await chatRoutes.replaceLibraryAppWithChatArtifact(
        storage,
        segments[1],
        artifactName,
        targetPath,
        emit,
        { expectedSourceVersion },
      );
      sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof ReplaceLibraryAppConflictError) {
        sendJson(res, 409, {
          code: "VERSION_CONFLICT",
          message: err.message,
          expected: err.expected,
          actual: err.actual,
        });
        return true;
      }
      throw err;
    }
    return true;
  }
  if (segments[0] === "chats" && segments[2] === "save-artifact-to-library" && segments.length === 3 && method === "POST") {
    // Promotes a `<name>.app/` chat artifact directory into the
    // workspace library. Sibling of save-to-library which only
    // handles single-file attachments. Issue #47, PR-E.
    await requireOwnedChat(pool, segments[1], userId);
    const body = (await parseBody(req)) as { name?: unknown; destSubpath?: unknown };
    const artifactName = typeof body?.name === "string" ? body.name : "";
    if (!artifactName) {
      throw new ValidationError("Missing 'name' in body");
    }
    const destSubpath =
      typeof body?.destSubpath === "string" && body.destSubpath.length > 0
        ? body.destSubpath
        : undefined;
    const result = await chatRoutes.saveArtifactToLibrary(
      storage,
      segments[1],
      artifactName,
      destSubpath,
      emit,
    );
    sendJson(res, 201, result);
    return true;
  }

  return false;
}
