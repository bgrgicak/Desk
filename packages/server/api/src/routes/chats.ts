import { type Pool } from "@desk/db";
import { Readable } from "node:stream";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { Cron } from "croner";
import { queries } from "@desk/db";
import { generateId, NotFoundError, ValidationError, AttachmentRefSchema, MESSAGE_KINDS, type AttachmentRef, type Message, type MessageKind, type WsEvent } from "@desk/shared";
import { z } from "zod";
import {
  chatAttachmentsDir,
  listNoteHistory,
  materializeNote,
  notesDir,
  pinLibraryFileToChat,
  snapshotNote,
  trashChatDirectories,
  uploadMessageAttachment,
  workspaceRootPath,
  type FileRef,
  type NoteVersion,
  type StorageContext,
} from "@desk/storage";

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
  fireMessage(messageId: string): Promise<{ fired: boolean; childIds: string[] }>;
}

/**
 * Resolves the on-disk slug for a chat's workspace. Used by route handlers
 * that need to build a filesystem path from a bare chatId. Throws if the
 * chat is missing.
 */
async function workspaceSlugForChat(pool: Pool, chatId: string): Promise<string> {
  const { rows } = await pool.query<{ path: string }>(
    `SELECT w.path FROM chats c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?`,
    [chatId],
  );
  if (rows.length === 0) throw new NotFoundError(`Chat not found: ${chatId}`);
  return rows[0].path;
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
  data: { title?: string; goal?: string; agentId?: string },
) {
  const chat = await queries.chats.updateMeta(pool, id, data);
  if (!chat) throw new NotFoundError(`Chat not found: ${id}`);
  return chat;
}

export async function listMessages(
  pool: Pool,
  chatId: string,
  opts?: { cursor?: string },
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
 * - `kind='task'` or `'ai_note'`: a single self-firing row. The schedule
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
  goal: z.string().optional(),
  /** Pre-allocated id, supplied by the multipart route so attachment
   * paths can include the message id before the row is inserted. */
  id: z.string().optional(),
});

/**
 * Translates a multipart `POST /chats/{id}/messages` form into the JSON
 * body shape `sendMessage` expects. Pre-allocates the message id so each
 * uploaded file lands at a path that already includes the message id —
 * no rename dance, no orphaning if the message-row insert succeeds.
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

  const messageId = generateId("message");
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
    const ref = await uploadMessageAttachment(storage, {
      workspaceSlug: ws.path,
      chatId,
      messageId,
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
    id: messageId,
    content,
    attachments: [...refs, ...uploaded],
  };
  for (const k of ["kind", "title", "executeAt", "cron"] as const) {
    const v = form.get(k);
    if (typeof v === "string" && v !== "") body[k] = v;
  }
  return body;
}

export async function sendMessage(
  pool: Pool,
  chatId: string,
  rawData: unknown,
  emit: (event: WsEvent) => void,
  opts?: { role?: "user" | "agent" | "system" },
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

  // Self-firing kinds (task, ai_note): one row, schedule on the row, fire
  // dispatches by kind. The "userMessage" / "triggerId" pair in the return
  // value is a chat-shape concession — both ids point at the same row so
  // app.ts can schedule the message id without branching.
  if (kind !== "chat") {
    const messageId = data.id ?? generateId("message");
    let executeAt = data.executeAt ?? null;
    if (data.cron && !executeAt) {
      const next = new Cron(data.cron).nextRun();
      if (!next) throw new ValidationError(`cron expression "${data.cron}" has no future occurrences`);
      executeAt = next.toISOString();
    }
    const message = await queries.messages.insert(pool, {
      id: messageId,
      chatId,
      role: opts?.role ?? "user",
      content: { type: "text", text: data.content },
      attachments,
      kind,
      title: data.title ?? null,
      state: "pending",
      executeAt,
      cron: data.cron ?? null,
      agentId: chat.agentId,
    });
    emit({ type: "message.appended", payload: message });
    return { userMessage: message, triggerId: messageId };
  }

  const userMessage = await queries.messages.insert(pool, {
    id: data.id ?? generateId("message"),
    chatId,
    role: "user",
    content: data.goal
      ? { type: "text", text: data.content, goal: data.goal }
      : { type: "text", text: data.content },
    attachments,
  });

  emit({ type: "message.appended", payload: userMessage });

  const triggerId = generateId("message");
  await queries.messages.insert(pool, {
    id: triggerId,
    chatId,
    role: "system",
    content: { type: "agent_turn", userMessageId: userMessage.id },
    state: "pending",
    parentId: userMessage.id,
    agentId: chat.agentId,
  });

  return { userMessage, triggerId };
}

/**
 * PATCH a message. Supports editing content (e.g. user edits a note) and
 * lifecycle transitions: `cancelled` (stop & keep the row), `paused`
 * (stop firing without losing the schedule), `pending` (resume from
 * paused). Returns the updated row. Emits message.updated over WS.
 *
 * State transitions delegate to the run manager (pause/resume/cancel);
 * content-only patches (e.g. user editing a note body) snapshot the prior
 * note and take the plain DB update path.
 */
export async function patchMessage(
  pool: Pool,
  storage: StorageContext,
  chatId: string,
  messageId: string,
  data: { content?: unknown; state?: string; executeAt?: string | null; cron?: string | null },
  emit: (event: WsEvent) => void,
  lifecycleOps: MessageLifecycleOps | null = null,
): Promise<Message> {
  const current = await queries.messages.findById(pool, messageId);
  if (!current || current.chatId !== chatId) {
    throw new NotFoundError(`Message not found in chat: ${messageId}`);
  }
  if (data.state !== undefined && !["cancelled", "pending", "paused"].includes(data.state)) {
    throw new ValidationError(
      `state can only be patched to 'cancelled', 'paused', or 'pending' via this endpoint`,
    );
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
    if (prev?.type === "note" && typeof prev.body === "string" || (data.content as { type?: string })?.type === "note") {
      const chat = await queries.chats.findById(pool, chatId);
      const ws = chat ? await queries.workspaces.findById(pool, chat.workspaceId) : null;
      if (ws) {
        if (prev?.type === "note" && typeof prev.body === "string") {
          await snapshotNote(storage.home, ws.path, chatId, messageId, prev.body);
        }
        const next = data.content as { type?: string; body?: string };
        if (next?.type === "note" && typeof next.body === "string") {
          await materializeNote(storage.home, ws.path, chatId, messageId, next.body).catch(() => { /* best-effort */ });
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
 * Runs a task message on demand. Used by the kanban "drag to Active"
 * gesture: forces the row back to `pending` then dispatches the agent.
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
  if (current.state === "running") return current;

  // Reset to pending so fireMessage can claim it.
  const reset = await queries.messages.updateMessage(pool, messageId, { state: "pending" });
  if (!reset) throw new NotFoundError(`Message not found: ${messageId}`);
  emit({ type: "message.updated", payload: reset });

  // Fire-and-forget. fireMessage's claimPending flips the row to
  // 'running' and broadcasts message.updated; the kanban picks that up
  // over WS and moves the card to the Active column. The full agent
  // run continues in the background.
  ops.fireMessage(messageId).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`runMessage fireMessage failed for ${messageId}:`, err);
  });

  return reset;
}

/**
 * Returns every archived version of the supplied note-content message,
 * newest first. Returns an empty list if no snapshots exist yet.
 */
export async function getNoteHistory(
  storage: StorageContext,
  chatId: string,
  messageId: string,
): Promise<{ versions: NoteVersion[] }> {
  const slug = await workspaceSlugForChat(storage.pool, chatId);
  const versions = await listNoteHistory(storage.home, slug, chatId, messageId);
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

  // Move log file to trash if present.
  const logPath = path.join(
    workspaceRootPath(storage.home, slug),
    ".chats",
    chatId,
    "logs",
    `${messageId}.log`,
  );
  await fs.access(logPath).then(async () => {
    const trashDir = path.join(storage.home, "Desk", ".trash");
    await fs.mkdir(trashDir, { recursive: true });
    await fs.rename(logPath, path.join(trashDir, `${Date.now()}-${messageId}.log`));
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
 * `attachment`: a user-uploaded file under `.chats/{id}/attachments/`.
 * `note`: a materialized mirror of a `note`-content message, written by
 * the runtime under `.chats/{id}/notes/{messageId}.md`. Notes are
 * read-only from the client's perspective — they're owned by the DB row.
 *
 * `label` is an optional human-friendly name the UI shows alongside the
 * raw file name (e.g. notes always carry "Chat notes" so the listing
 * doesn't expose the messageId-based filename as the primary label).
 */
export type ChatFileRef = FileRef & {
  kind: "attachment" | "note";
  label?: string;
};

/**
 * Lists a chat's attachments from the filesystem. By default returns only
 * visible (non-dot) entries — the user-uploaded chat files plus any
 * agent-finalized output. Passing `showHidden: true` includes agent
 * artifacts (dot-prefixed drafts / scratch) for the chat Artifacts panel
 * or a diagnostic view. Passing `includeNotes: true` also walks
 * `.chats/{id}/notes/` so the chat Files panel can show note mirrors
 * alongside uploads — each item is tagged with `kind` so the UI can
 * render them differently.
 */
export async function listAttachments(
  storage: StorageContext,
  chatId: string,
  opts?: { showHidden?: boolean; includeNotes?: boolean },
): Promise<ChatFileRef[]> {
  const slug = await workspaceSlugForChat(storage.pool, chatId);
  const root = workspaceRootPath(storage.home, slug);
  const showHidden = opts?.showHidden ?? false;
  const out: ChatFileRef[] = [];

  // Legacy path: pinned library refs and old direct uploads land here.
  const attDir = await chatAttachmentsDir(storage.home, slug, chatId);
  const attNames = await fs.readdir(attDir).catch(() => [] as string[]);
  for (const name of attNames) {
    if (!showHidden && name.startsWith(".")) continue;
    const abs = path.join(attDir, name);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    out.push({
      path: path.relative(root, abs).split(path.sep).join("/"),
      name,
      mime: "application/octet-stream",
      size: stat.size,
      createdAt: stat.birthtime.toISOString(),
      kind: "attachment",
    });
  }

  // Message-scoped uploads: `.chats/{id}/messages/{msgId}/{name}`. Each
  // user message that carried files gets its own subdir. Flatten the
  // tree into the same list so the Files panel shows uploads regardless
  // of which path produced them.
  const msgsDir = path.join(root, ".chats", chatId, "messages");
  const msgIds = await fs.readdir(msgsDir).catch(() => [] as string[]);
  for (const msgId of msgIds) {
    if (msgId.startsWith(".")) continue;
    const sub = path.join(msgsDir, msgId);
    const fileNames = await fs.readdir(sub).catch(() => [] as string[]);
    for (const name of fileNames) {
      if (!showHidden && name.startsWith(".")) continue;
      const abs = path.join(sub, name);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      out.push({
        path: path.relative(root, abs).split(path.sep).join("/"),
        name,
        mime: "application/octet-stream",
        size: stat.size,
        createdAt: stat.birthtime.toISOString(),
        kind: "attachment",
      });
    }
  }

  if (opts?.includeNotes) {
    const nDir = notesDir(storage.home, slug, chatId);
    const noteNames = await fs.readdir(nDir).catch(() => [] as string[]);
    for (const name of noteNames) {
      // Notes are always materialized as `{messageId}.md`; skip anything
      // that doesn't match so a stray dotfile doesn't show up.
      if (!name.endsWith(".md")) continue;
      const abs = path.join(nDir, name);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      out.push({
        path: path.relative(root, abs).split(path.sep).join("/"),
        name,
        mime: "text/markdown",
        size: stat.size,
        createdAt: stat.birthtime.toISOString(),
        kind: "note",
        label: "Chat notes",
      });
    }
  }

  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
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

/**
 * Uploads a user-visible attachment to a chat. Streams directly, no DB
 * row. The storage layer rejects dot-prefixed filenames (reserved for
 * agent artifacts). Returns a FileRef with the new workspace-relative
 * path.
 */
/**
 * Pins a library file into the chat's "In this chat" sidebar by
 * symlinking it under `.chats/{chatId}/attachments/`. The library file
 * stays where it is — only a link is created, so deleting the chat
 * doesn't affect the workspace library.
 */
export async function pinLibraryFile(
  storage: StorageContext,
  chatId: string,
  libraryPath: string,
  emit: (event: WsEvent) => void,
): Promise<FileRef> {
  const chat = await queries.chats.findById(storage.pool, chatId);
  if (!chat) throw new NotFoundError(`Chat not found: ${chatId}`);
  const ws = await queries.workspaces.findById(storage.pool, chat.workspaceId);
  if (!ws) throw new NotFoundError(`Workspace not found: ${chat.workspaceId}`);

  const file = await pinLibraryFileToChat(storage, ws.path, chatId, libraryPath);
  emit({ type: "artifact.created", payload: file });
  return file;
}

