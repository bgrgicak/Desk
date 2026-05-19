import { type Pool } from "@agent-desk/db";
import { Readable } from "node:stream";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { Cron } from "croner";
import { queries } from "@agent-desk/db";
import { generateId, ConflictError, NotFoundError, ValidationError, AttachmentRefSchema, MESSAGE_KINDS, MessageContentSchema, type AttachmentRef, type Chat, type Message, type MessageKind, type WsEvent } from "@agent-desk/shared";
import { z } from "zod";
import {
  listSummaryHistory,
  deleteMaterializedSummary,
  snapshotSummary,
  snapshotAndReplaceSummary,
  trashChatDirectories,
  trashDir,
  uploadArtifact,
  workspaceRootPath,
  type SummaryVersion,
  type StorageContext,
} from "@agent-desk/storage";
import { withModule } from "@agent-desk/shared/logger";
import { workspaceSlugForChat } from "./chats-shared.js";

const log = withModule("api/routes/chats");

// Attachment / library / .app surface lives in a sibling module so this
// file can stay focused on chat-and-message lifecycle.  The re-exports
// at the bottom keep the `chatRoutes.*` namespace stable for app.ts.
export {
  attachArtifactRef,
  listAttachments,
  pinLibraryFile,
  saveAttachmentToLibrary,
  saveArtifactToLibrary,
  copyAppFromLibrary,
  replaceLibraryAppWithChatArtifact,
  removeAttachment,
  removeChatApp,
  removeLibraryApp,
} from "./chats-attachments.js";
export type { ChatFileRef } from "./chats-attachments.js";

const IsoUtcDateTimeSchema = z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z"), {
  message: "datetime must be UTC and end with Z",
});

/**
 * Subset of the run manager the patch-message route needs to drive
 * scheduler-aware state transitions (pause / resume / cancel-in-place).
 * Kept as its own interface so chats.ts doesn't depend on the whole
 * scheduler package.
 */
export interface MessageLifecycleOps {
  pauseMessage(messageId: string): Promise<Message | null>;
  resumeMessage(messageId: string): Promise<Message | null>;
  cancelScheduledMessage(messageId: string): Promise<Message | null>;
  /** Re-compute execute_at after a PATCH that changes schedule fields
   * without crossing a state boundary. For cron tasks this means calling
   * croner to get the next occurrence. */
  rescheduleMessage(messageId: string): Promise<Message | null>;
  /** Claims the row and runs the agent in-process. */
  fireMessage(messageId: string, options?: { manual?: boolean }): Promise<{ fired: boolean; childIds: string[] }>;
}

export async function listChats(pool: Pool, workspaceId: string) {
  return queries.chats.listWithLatestMessage(pool, workspaceId);
}

export async function getChat(pool: Pool, id: string) {
  const chat = await queries.chats.findById(pool, id);
  if (!chat) throw new NotFoundError(`Chat not found: ${id}`);
  return chat;
}

export async function createChat(
  pool: Pool,
  data: { workspaceId: string; agentId: string; title: string; goal?: string },
) {
  return queries.chats.insert(pool, {
    id: generateId("chat"),
    ...data,
  });
}

export async function patchChat(
  pool: Pool,
  id: string,
  data: { title?: string; goal?: string | null; agentId?: string; unread?: boolean },
) {
  const { unread, ...metaFields } = data;
  const hasMetaFields = Object.values(metaFields).some(v => v !== undefined);

  // When meta fields and unread are both present, merge into a single UPDATE
  // so the RETURNING * snapshot is atomic across both changes.
  // When only unread is being cleared, delegate to markRead which uses a
  // targeted UPDATE for the same atomicity guarantee.
  // Note: when agentId is in the patch, `updateMeta` also atomically
  // nulls opencode_session_id — opencode-serve binds providerID/modelID
  // to the session at creation, so reusing the old session after a
  // model swap would silently keep the prior model.
  if (hasMetaFields) {
    const updateData = unread !== undefined ? { ...metaFields, unread } : metaFields;
    const chat = await queries.chats.updateMeta(pool, id, updateData);
    if (!chat) throw new NotFoundError(`Chat not found: ${id}`);
    return chat;
  }

  if (unread === false) {
    const chat = await queries.chats.markRead(pool, id);
    if (!chat) throw new NotFoundError(`Chat not found: ${id}`);
    return chat;
  }

  const chat = await queries.chats.findById(pool, id);
  if (!chat) throw new NotFoundError(`Chat not found: ${id}`);
  return chat;
}

export async function listMessages(
  pool: Pool,
  chatId: string,
  opts?: { cursor?: string; before?: string; limit?: number; view?: "full" | "compact" | "timeline" },
) {
  return queries.messages.listByChat(pool, chatId, opts);
}

/**
 * User sends a message into a chat. Two write shapes depending on kind:
 *
 * - `kind='chat'` (default): a user-role text row plus a pending system
 *   `agent_turn` trigger that references the user message. fireMessage
 *   resolves the trigger at fire time, reads the parent user message's
 *   text as the prompt. No duplication of payload.
 * - `kind='task'` or `'summary'`: a single self-firing row. The schedule
 *   (`executeAt` / `cron`) lives directly on it; fireMessage dispatches
 *   on `kind` to know what to run. No separate trigger.
 *
 * Callers (app.ts) get the trigger's id (or the message id for self-firing
 * kinds) back to schedule the fire.
 */
const SendMessageSchema = z.object({
  content: z.string(),
  attachments: z.array(AttachmentRefSchema).optional(),
  kind: z.enum(MESSAGE_KINDS).optional(),
  title: z.string().optional(),
  executeAt: z.string().optional(),
  cron: z.string().optional(),
  goal: z.string().nullable().optional(),
});

export function validateSendMessageBody(rawData: unknown): void {
  const parsed = SendMessageSchema.safeParse(rawData);
  if (!parsed.success) {
    throw new ValidationError(`Invalid message body: ${parsed.error.message}`);
  }
}

/**
 * Translates a multipart `POST /chats/{id}/messages` form into the JSON
 * body shape `sendMessage` expects. Files land under
 * `.chats/{id}/attachments/` (the canonical chat-attachment home);
 * `uploadArtifact` handles same-name collisions by appending `-N`.
 *
 * Form fields:
 *   content           — message text (required, may be empty)
 *   attachment        — file part(s); repeated for multi-attachment sends
 *   attachments       — JSON array of AttachmentRef for refs without a
 *                       file body (library mentions)
 *   kind/title/executeAt/cron — optional, same semantics as the JSON path
 */
export async function buildSendMessageBodyFromForm(
  storage: StorageContext,
  chatId: string,
  form: FormData,
): Promise<unknown> {
  const chat = await queries.chats.findById(storage.pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);
  const ws = await queries.workspaces.findById(storage.pool, chat.workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${chat.workspaceId}`);

  const content = typeof form.get("content") === "string" ? (form.get("content") as string) : "";

  // Library-mention refs ride alongside file uploads — same array on the
  // wire, distinguished only by whether a file part is present.
  const refsRaw = form.get("attachments");
  const refs: AttachmentRef[] = [];
  if (typeof refsRaw === "string" && refsRaw !== "") {
    const parsed = z.array(AttachmentRefSchema).safeParse(JSON.parse(refsRaw));
    if (!parsed.success) {
      throw new ValidationError(`Invalid 'attachments' JSON: ${parsed.error.message}`);
    }
    refs.push(...parsed.data);
  }

  const fileParts = form.getAll("attachment").filter((p): p is File => p instanceof Blob);
  const uploaded: AttachmentRef[] = [];
  for (const part of fileParts) {
    const name = part.name || "upload";
    const mime = part.type || "application/octet-stream";
    const stream = Readable.from(Buffer.from(await part.arrayBuffer()));
    const ref = await uploadArtifact(storage, {
      workspaceId: chat.workspaceId,
      workspaceSlug: ws.path,
      chatId,
      name,
      mime,
      stream,
    });
    uploaded.push({
      path: ref.path,
      name: ref.name,
      mime: ref.mime,
      size: ref.size,
    });
  }

  const body: Record<string, unknown> = {
    content,
    attachments: [...refs, ...uploaded],
  };
  for (const k of ["kind", "title", "executeAt", "cron"] as const) {
    const v = form.get(k);
    if (typeof v === "string" && v !== "") body[k] = v;
  }
  const goal = form.get("goal");
  if (typeof goal === "string") body.goal = goal === "" ? null : goal;
  return body;
}

export async function sendMessage(
  pool: Pool,
  chatId: string,
  rawData: unknown,
  emit: (event: WsEvent) => void,
  opts?: { role?: "user" | "agent" | "system"; actorUserId?: string },
): Promise<{ userMessage: Message; triggerId: string }> {
  const parsed = SendMessageSchema.safeParse(rawData);
  if (!parsed.success) {
    throw new ValidationError(`Invalid message body: ${parsed.error.message}`);
  }
  const data = parsed.data;

  const chat = await queries.chats.findById(pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);

  const attachments: AttachmentRef[] | undefined =
    data.attachments && data.attachments.length > 0 ? data.attachments : undefined;

  const kind: MessageKind = data.kind ?? "chat";
  const senderRole = kind === "chat" ? "user" : opts?.role ?? "user";

  if (data.goal !== undefined) {
    await queries.chats.updateMeta(pool, chatId, { goal: data.goal });
  }

  // Self-firing kinds (task, summary): one row, schedule on the row, fire
  // dispatches by kind. The "userMessage" / "triggerId" pair in the return
  // value is a chat-shape concession — both ids point at the same row so
  // app.ts can schedule the message id without branching.
  if (kind !== "chat") {
    const messageId = generateId("message");
    let executeAt = data.executeAt ?? null;
    if (data.cron && !executeAt) {
      const next = new Cron(data.cron).nextRun();
      if (!next) throw new ValidationError(`cron expression "${data.cron}" has no future occurrences`);
      executeAt = next.toISOString();
    }
    const message = await queries.messages.insert(pool, {
      id: messageId,
      chatId,
      role: senderRole,
      content: { type: "text", text: data.content },
      attachments,
      kind,
      title: data.title ?? null,
      state: "pending",
      executeAt,
      cron: data.cron ?? null,
      agentId: chat.agentId,
    });
    emit({ type: "message.appended", payload: message, workspaceId: chat.workspaceId, chatTitle: chat.title, actorUserId: opts?.actorUserId });
    return { userMessage: message, triggerId: messageId };
  }

  const userMessage = await queries.messages.insert(pool, {
    id: generateId("message"),
    chatId,
    role: "user",
    content: { type: "text", text: data.content },
    attachments,
  });

  emit({ type: "message.appended", payload: userMessage, workspaceId: chat.workspaceId, chatTitle: chat.title, actorUserId: opts?.actorUserId });

  const triggerId = generateId("message");
  const trigger = await queries.messages.insert(pool, {
    id: triggerId,
    chatId,
    role: "system",
    content: { type: "agent_turn", userMessageId: userMessage.id },
    state: "pending",
    parentId: userMessage.id,
    agentId: chat.agentId,
  });
  emit({ type: "message.appended", payload: trigger, workspaceId: chat.workspaceId, chatTitle: chat.title, actorUserId: opts?.actorUserId });

  return { userMessage, triggerId };
}

const CreateThreadSchema = z.object({
  content: z.string(),
  workspaceId: z.string().optional(),
  agentId: z.string().optional(),
});

export interface CreateThreadResult {
  /** The new chat that holds the thread transcript. */
  threadChat: Chat;
  /** The user message that started the thread. */
  threadStartMessage: Message;
  /** Pending agent_turn id; caller fires it. */
  triggerId: string;
  /** Anchor message after `thread_chat_id` was set on it. Emit
   * `message.updated` so subscribers can patch the parent chat row. */
  anchorMessage: Message;
}

/**
 * Creates a thread anchored at `messageId` in `chatId`. Behaviour:
 *
 * - The anchor message is not copied. `messages.thread_chat_id` is set
 *   on the anchor; the referenced chat is otherwise a normal chat row.
 * - One thread per anchor message; a duplicate request returns 409.
 * - For project parents, the thread chat must live in the same workspace
 *   (the optional `workspaceId` body field, when supplied, must match).
 * - Hub parents may target any owned workspace. UI-created threads omit
 *   `workspaceId` and inherit the parent chat's workspace.
 * - The agent for the thread chat: explicit `agentId` wins; otherwise
 *   the parent chat's agent is reused when it's enabled in the target
 *   workspace; otherwise the workspace's first enabled agent. The
 *   selected agent must be enabled in the target workspace.
 * - Insert a normal user message into the thread chat and a pending
 *   `agent_turn` trigger. Caller is expected to fire the trigger and
 *   schedule a summary, mirroring the regular send-message path.
 */
export async function createThread(
  pool: Pool,
  parentChatId: string,
  anchorMessageId: string,
  rawData: unknown,
  emit: (event: WsEvent) => void,
  opts?: { actorUserId?: string; userId: string },
): Promise<CreateThreadResult> {
  const parsed = CreateThreadSchema.safeParse(rawData);
  if (!parsed.success) {
    throw new ValidationError(`Invalid thread body: ${parsed.error.message}`);
  }
  const data = parsed.data;
  if (data.content.trim() === "") {
    throw new ValidationError("Thread starting message content must not be empty");
  }

  const parentChat = await queries.chats.findById(pool, parentChatId);
  if (!parentChat) throw new NotFoundError(`Chat not found: ${parentChatId}`);

  const anchorMessage = await queries.messages.findById(pool, anchorMessageId);
  if (!anchorMessage || anchorMessage.chatId !== parentChatId) {
    throw new NotFoundError(`Message not found in chat: ${anchorMessageId}`);
  }
  if (anchorMessage.threadChatId) {
    throw new ConflictError(
      `Message already has a thread: ${anchorMessageId}`,
    );
  }

  const parentWorkspace = await queries.workspaces.findById(pool, parentChat.workspaceId);
  if (!parentWorkspace) {
    throw new NotFoundError(`Workspace not found: ${parentChat.workspaceId}`);
  }

  // Workspace targeting policy: project parents stay in their workspace,
  // hub parents may target any of the user's workspaces.
  let targetWorkspaceId = data.workspaceId ?? parentChat.workspaceId;
  if (parentWorkspace.kind === "project" && targetWorkspaceId !== parentChat.workspaceId) {
    throw new ValidationError(
      "Project workspace threads must live in the same workspace",
    );
  }
  const targetWorkspace = await queries.workspaces.findById(pool, targetWorkspaceId);
  if (!targetWorkspace || targetWorkspace.userId !== opts?.userId) {
    throw new NotFoundError(`Workspace not found: ${targetWorkspaceId}`);
  }
  targetWorkspaceId = targetWorkspace.id;

  // Pick the agent for the thread chat. Explicit > parent's agent (if
  // enabled in target) > workspace's first enabled agent.
  const enabledAgents = await queries.workspaceAgents.listForWorkspace(
    pool,
    targetWorkspaceId,
  );
  if (enabledAgents.length === 0) {
    throw new ValidationError(
      `Workspace has no enabled agents: ${targetWorkspaceId}`,
    );
  }
  const enabledIds = new Set(enabledAgents.map((a) => a.agentId));
  let agentId: string | undefined;
  if (data.agentId) {
    if (!enabledIds.has(data.agentId)) {
      throw new ValidationError(
        `Agent ${data.agentId} is not enabled in workspace ${targetWorkspaceId}`,
      );
    }
    agentId = data.agentId;
  } else if (enabledIds.has(parentChat.agentId)) {
    agentId = parentChat.agentId;
  } else {
    agentId = enabledAgents[0].agentId;
  }

  // Create the thread chat. Title borrows from the parent chat so the
  // sidebar entry is recognisable; the UI can rename later.
  const threadChat = await queries.chats.insert(pool, {
    id: generateId("chat"),
    workspaceId: targetWorkspaceId,
    agentId,
    title: parentChat.title ? `Thread: ${parentChat.title}` : "Thread",
  });

  // Atomically claim the anchor as the parent of this thread. If a
  // concurrent request already created a thread for the same anchor,
  // the UPDATE fails its WHERE guard and we surface 409.
  const claimedAnchor = await queries.messages.setThreadChatId(
    pool,
    anchorMessageId,
    threadChat.id,
  );
  if (!claimedAnchor) {
    // Roll back the thread chat we just created so we don't leak an
    // orphan workspace chat. messages.chat_id has ON DELETE CASCADE so
    // any rows we inserted (none yet) would also go.
    await pool.query("DELETE FROM chats WHERE id = ?", [threadChat.id]);
    throw new ConflictError(
      `Message already has a thread: ${anchorMessageId}`,
    );
  }

  emit({
    type: "chat.updated",
    payload: threadChat,
  });

  // The thread-starting message is a normal user message in the new chat.
  const threadStartMessage = await queries.messages.insert(pool, {
    id: generateId("message"),
    chatId: threadChat.id,
    role: "user",
    content: { type: "text", text: data.content },
  });
  emit({
    type: "message.appended",
    payload: threadStartMessage,
    workspaceId: threadChat.workspaceId,
    chatTitle: threadChat.title,
    actorUserId: opts?.actorUserId,
  });

  const triggerId = generateId("message");
  const trigger = await queries.messages.insert(pool, {
    id: triggerId,
    chatId: threadChat.id,
    role: "system",
    content: { type: "agent_turn", userMessageId: threadStartMessage.id },
    state: "pending",
    parentId: threadStartMessage.id,
    agentId,
  });
  emit({
    type: "message.appended",
    payload: trigger,
    workspaceId: threadChat.workspaceId,
    chatTitle: threadChat.title,
    actorUserId: opts?.actorUserId,
  });

  // Notify subscribers that the anchor now has a threadChatId so the
  // parent chat's transcript can render the "open thread" affordance.
  emit({ type: "message.updated", payload: claimedAnchor });

  return {
    threadChat,
    threadStartMessage,
    triggerId,
    anchorMessage: claimedAnchor,
  };
}

/**
 * PATCH a message. Supports editing content (e.g. user edits a summary) and
 * lifecycle transitions: `cancelled` (stop & keep the row), `paused`
 * (stop firing without losing the schedule), `pending` (resume from
 * paused). Returns the updated row. Emits message.updated over WS.
 *
 * State transitions delegate to the run manager (pause/resume/cancel);
 * content-only patches (e.g. user editing a summary body) snapshot the prior
 * summary and take the plain DB update path.
 */
export async function patchMessage(
  pool: Pool,
  storage: StorageContext,
  chatId: string,
  messageId: string,
  data: { content?: unknown; state?: string; executeAt?: string | null; cron?: string | null; kind?: MessageKind; title?: string | null },
  emit: (event: WsEvent) => void,
  lifecycleOps: MessageLifecycleOps | null = null,
): Promise<Message> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ValidationError("Message patch body must be an object");
  }
  if (Object.keys(data).length === 0) {
    throw new ValidationError("Message patch body cannot be empty");
  }
  const current = await queries.messages.findById(pool, messageId);
  if (!current || current.chatId !== chatId) {
    throw new NotFoundError(`Message not found in chat: ${messageId}`);
  }
  if (data.state !== undefined && !["cancelled", "pending", "paused"].includes(data.state)) {
    throw new ValidationError(
      `state can only be patched to 'cancelled', 'paused', or 'pending' via this endpoint`,
    );
  }
  if (data.kind !== undefined) {
    if (data.kind !== "chat") {
      throw new ValidationError("kind can only be patched to 'chat' via this endpoint");
    }
    if (current.kind !== "task") {
      throw new ValidationError("only task messages can be converted back to chat messages");
    }
  }
  if (data.title !== undefined) {
    if (data.title !== null && typeof data.title !== "string") {
      throw new ValidationError("title must be a string or null");
    }
    if (typeof data.title === "string") {
      const title = data.title.trim();
      if (!title) throw new ValidationError("title cannot be empty");
      data.title = title;
    }
  }
  if (data.executeAt !== undefined) {
    if (data.executeAt !== null && typeof data.executeAt !== "string") {
      throw new ValidationError("executeAt must be an ISO datetime string or null");
    }
    if (typeof data.executeAt === "string") {
      const parsed = IsoUtcDateTimeSchema.safeParse(data.executeAt);
      if (!parsed.success) {
        throw new ValidationError(`executeAt must be a valid ISO UTC datetime string: ${parsed.error.message}`);
      }
      const match = parsed.data.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/);
      const date = new Date(parsed.data);
      if (
        !match ||
        date.getUTCFullYear() !== Number(match[1]) ||
        date.getUTCMonth() + 1 !== Number(match[2]) ||
        date.getUTCDate() !== Number(match[3]) ||
        date.getUTCHours() !== Number(match[4]) ||
        date.getUTCMinutes() !== Number(match[5]) ||
        date.getUTCSeconds() !== Number(match[6])
      ) {
        throw new ValidationError("executeAt must be a valid ISO UTC datetime string");
      }
    }
  }
  if (data.cron !== undefined) {
    if (data.cron !== null && typeof data.cron !== "string") {
      throw new ValidationError("cron must be a string or null");
    }
    if (typeof data.cron === "string") {
      const cron = data.cron.trim();
      if (!cron) throw new ValidationError("cron cannot be empty");
      try {
        new Cron(cron);
      } catch (err) {
        throw new ValidationError(err instanceof Error ? err.message : "Invalid cron expression");
      }
      data.cron = cron;
    }
  }
  if (data.content !== undefined) {
    const parsedContent = MessageContentSchema.safeParse(data.content);
    if (!parsedContent.success) {
      throw new ValidationError(`Invalid message content: ${parsedContent.error.message}`);
    }
    data.content = parsedContent.data;
  }
  // A no-op state patch (e.g. `state: 'pending'` on an already-pending row)
  // is allowed and falls through to the field-only path below — the kanban
  // board sends the column's target state on every drop without inspecting
  // the row's current state.
  const stateTransition = data.state !== undefined && data.state !== current.state;
  // For non-task messages the running state is claimed atomically by
  // fireMessage — a manual flip would race with the executor. Task messages
  // (kind='task') are different: the executor claims the task_run child, so
  // the parent's running state is only a kanban-position signal and can be
  // patched freely.
  if (stateTransition && current.state === "running" && current.kind !== "task") {
    throw new ValidationError(
      `cannot patch state of a running message; cancel or wait for it to finish`,
    );
  }

  if (data.content !== undefined) {
    const prev = current.content as { type?: string; body?: string };
    if (
      (prev?.type === "summary" && typeof prev.body === "string") ||
      (data.content as { type?: string })?.type === "summary"
    ) {
      const chat = await queries.chats.findById(pool, chatId);
      const ws = chat ? await queries.workspaces.findById(pool, chat.workspaceId) : null;
      if (ws) {
        const next = data.content as { type?: string; body?: string };
        if (next?.type === "summary" && typeof next.body === "string") {
          // Per-chat lock + atomic write — two concurrent PATCHes can no
          // longer drop the intermediate body from history.
          await snapshotAndReplaceSummary(
            storage.home,
            ws.path,
            chatId,
            messageId,
            next.body,
          ).catch(() => { /* best-effort */ });
        } else if (prev?.type === "summary" && typeof prev.body === "string") {
          // Content changed away from a summary — preserve the body in history.
          await snapshotSummary(storage.home, ws.path, chatId, messageId, prev.body);
        }
      }
    }
  }

  // Apply non-state fields first so the lifecycle op observes the new
  // schedule when it runs (e.g. resumeMessage sees the updated execute_at).
  if (stateTransition && lifecycleOps) {
    const preTransition = { ...data };
    delete preTransition.state;
    if (Object.keys(preTransition).length > 0) {
      await queries.messages.updateMessage(pool, messageId, preTransition);
    }
    let updated: Message | null = null;
    if (data.state === "paused") updated = await lifecycleOps.pauseMessage(messageId);
    else if (data.state === "pending") updated = await lifecycleOps.resumeMessage(messageId);
    else if (data.state === "cancelled") updated = await lifecycleOps.cancelScheduledMessage(messageId);
    if (!updated) throw new NotFoundError(`Message not found: ${messageId}`);
    return updated;
  }

  // Non-transition path: apply the DB update, then if the schedule changed,
  // let rescheduleMessage recompute execute_at from the new cron expression.
  const updated = await queries.messages.updateMessage(pool, messageId, data);
  if (!updated) throw new NotFoundError(`Message not found: ${messageId}`);
  if (lifecycleOps && (data.executeAt !== undefined || data.cron !== undefined)) {
    const synced = await lifecycleOps.rescheduleMessage(messageId);
    return synced ?? updated;
  }
  emit({ type: "message.updated", payload: updated });
  return updated;
}

/**
 * Runs a message on demand. Used by the kanban "drag to Active"
 * gesture and task detail manual-run action.
 * Re-fires terminal rows (succeeded/failed/cancelled) too — the column
 * drop is the user's "do it again, now" intent. Idempotent if the row
 * is already running: returns the current row without firing twice.
 */
export async function runMessage(
  pool: Pool,
  chatId: string,
  messageId: string,
  ops: MessageLifecycleOps,
  emit: (event: WsEvent) => void,
): Promise<Message> {
  const current = await queries.messages.findById(pool, messageId);
  if (!current || current.chatId !== chatId) {
    throw new NotFoundError(`Message not found in chat: ${messageId}`);
  }
  if (current.state === "running" && current.kind !== "task") return current;

  // Non-task messages are claimed in-place by fireMessage and must be reset
  // to pending before a manual re-fire. Task executions happen on a fresh
  // task_run child. For unscheduled tasks, POST /run is also the kanban
  // "move to Active" gesture, so persist that explicit user-owned status and
  // let the scheduler record completion/failure only on the task_run child.
  const rowToReturn = current.kind === "task"
    ? (!current.executeAt && !current.cron
      ? await queries.messages.updateMessage(pool, messageId, { state: "running" })
      : current)
    : await queries.messages.updateMessage(pool, messageId, { state: "pending" });
  if (!rowToReturn) throw new NotFoundError(`Message not found: ${messageId}`);
  if (current.kind !== "task" || rowToReturn !== current) emit({ type: "message.updated", payload: rowToReturn });

  // Fire-and-forget. The full agent run continues on the message itself for
  // non-task rows and on a task_run child for task rows.
  ops.fireMessage(messageId, { manual: true }).catch((err) => {
    log.error({ err, messageId }, "runMessage fireMessage failed");
  });

  return rowToReturn;
}

/**
 * Returns every archived version of the supplied summary-content message,
 * newest first. Returns an empty list if no snapshots exist yet.
 */
export async function getSummaryHistory(
  storage: StorageContext,
  chatId: string,
  messageId: string,
): Promise<{ versions: SummaryVersion[] }> {
  const slug = await workspaceSlugForChat(storage.pool, chatId);
  const versions = await listSummaryHistory(storage.home, slug, chatId, messageId);
  return { versions };
}

/**
 * Deletes a message. Idempotent — deleting an already-gone message
 * returns 404.
 */
export async function deleteMessage(
  pool: Pool,
  storage: StorageContext,
  chatId: string,
  messageId: string,
): Promise<void> {
  const msg = await queries.messages.findById(pool, messageId);
  if (!msg || msg.chatId !== chatId) {
    throw new NotFoundError(`Message not found in chat: ${messageId}`);
  }

  const slug = await workspaceSlugForChat(pool, chatId);

  await pool.query("DELETE FROM messages WHERE id = ?", [messageId]);

  if (msg.content.type === "summary") {
    await deleteMaterializedSummary(storage.home, slug, chatId, messageId).catch(() => {
      // Best-effort; deleting the DB row is the source of truth.
    });
  }

  // Move log file to trash if present.
  const logPath = path.join(
    workspaceRootPath(storage.home, slug),
    ".chats",
    chatId,
    "logs",
    `${messageId}.log`,
  );
  await fs.access(logPath).then(async () => {
    const trash = trashDir(storage.home);
    await fs.mkdir(trash, { recursive: true });
    await fs.rename(logPath, path.join(trash, `${Date.now()}-${messageId}.log`));
  }).catch(() => { /* no log file, fine */ });
}

/**
 * Tails the log file for a running (or completed) message. Returns the
 * body content stripped of kind prefixes, as a plain-text stream.
 */
export async function getMessageLogs(
  storage: StorageContext,
  chatId: string,
  messageId: string,
): Promise<{ stream: NodeJS.ReadableStream; contentType: string }> {
  const slug = await workspaceSlugForChat(storage.pool, chatId);
  const logPath = path.join(
    workspaceRootPath(storage.home, slug),
    ".chats",
    chatId,
    "logs",
    `${messageId}.log`,
  );
  await fs.access(logPath).catch(() => {
    throw new NotFoundError(`No logs for message: ${messageId}`);
  });
  return { stream: createReadStream(logPath), contentType: "text/plain; charset=utf-8" };
}

/**
 * Soft-deletes a chat. Cancels scheduler refs for every pending/recurring
 * message, deletes the chat row (FK cascade drops all message rows), and
 * moves the chat's on-disk directories to `~/Desk/.trash/`. Emits a
 * `chat.deleted` WS event with the deleted chat's ids so clients can drop
 * it from their sidebar. Returns the (now-removed) workspace id so the
 * caller can broadcast the event correctly.
 */
export async function deleteChat(
  pool: Pool,
  storage: StorageContext,
  chatId: string,
  emit: (event: WsEvent) => void,
): Promise<{ ok: true }> {
  const chat = await queries.chats.findById(pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);

  const ws = await queries.workspaces.findById(pool, chat.workspaceId);

  // FK ON DELETE CASCADE drops messages rows transactionally with the chat.
  await pool.query("DELETE FROM chats WHERE id = ?", [chatId]);

  if (ws) {
    await trashChatDirectories(storage.home, ws.path, chatId).catch(() => {
      // Best-effort; DB state is already gone.
    });
  }

  emit({
    type: "chat.deleted",
    payload: { chatId, workspaceId: chat.workspaceId },
  });

  return { ok: true };
}
