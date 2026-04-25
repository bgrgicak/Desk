import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import pg from "pg";
import {
  generateId,
  AgentEventSchema,
  type AgentLogEntry,
  type Message,
  type WsEvent,
} from "@desk/shared";
import { queries } from "@desk/db";
import { resolveDeskHome } from "@desk/storage";
import {
  createOrReuse,
  execRun as runtimeExecRun,
  cancelRun as runtimeCancelRun,
  createDriver,
  type LogEvent,
  type AgentFileInput,
} from "@desk/runtime";
import { createAdapter, type ScheduleAdapter } from "./scheduleAdapter.js";

export interface RunManagerOptions {
  pool: pg.Pool;
  adapter?: ScheduleAdapter;
  emit?: (event: WsEvent) => void;
  /**
   * Test-injectable replacement for the runtime's opencode spawn. Called
   * by fireMessage with the message id (as the "runId" arg, for log
   * correlation), the resolved agent, the derived prompt, and a log
   * sink. Return the exit code; the scheduler handles state transitions
   * and child-message insertion.
   */
  execRunFn?: (
    messageId: string,
    agentId: string,
    prompt: string,
    onLog: (evt: LogEvent) => void | Promise<void>,
    opts?: { agentFileInput: AgentFileInput; attachments?: string[] },
  ) => Promise<{ exitCode: number }>;
}

/**
 * Builds the shell command at/cron runs to fire a scheduled message.
 * The token is read fresh from disk at fire time via $(cat ...) so
 * rotations don't invalidate scheduled entries (reconcile regenerates).
 */
export function buildMessageFireCmd(messageId: string): string {
  const tokenPath = process.env.DESK_INTERNAL_TOKEN_PATH ?? "/etc/desk-server/internal-token";
  const port = process.env.DESK_API_PORT ?? process.env.PORT ?? "8080";
  const url = `http://127.0.0.1:${port}/internal/messages/fire`;
  const body = JSON.stringify({ messageId }).replace(/"/g, '\\"');
  return (
    `sh -c 'T=$(cat ${tokenPath}) && ` +
    `curl -sf -X POST ` +
    `-H "Authorization: Bearer $T" ` +
    `-H "Content-Type: application/json" ` +
    `-d "${body}" ` +
    `${url}'`
  );
}

export function createRunManager(opts: RunManagerOptions) {
  const { pool, emit = () => {} } = opts;
  const adapter = opts.adapter ?? createAdapter();

  async function getDefaultAgentId(): Promise<string> {
    const agents = await queries.agents.list(pool);
    if (agents.length === 0) throw new Error("No agents configured");
    return agents[0].id;
  }

  async function firstWorkspaceId(): Promise<string> {
    const { rows } = await pool.query(
      "SELECT id FROM workspaces ORDER BY created_at LIMIT 1",
    );
    return rows[0]?.id as string;
  }

  async function resolveUserIdForWorkspace(workspaceId: string): Promise<string | null> {
    if (!workspaceId) return null;
    const ws = await queries.workspaces.findById(pool, workspaceId);
    return ws?.userId ?? null;
  }

  async function ensureLogDir(workspaceSlug: string, chatId: string): Promise<string> {
    const home = resolveDeskHome();
    const dir = path.join(home, "Desk", "workspaces", workspaceSlug, ".chats", chatId, "logs");
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Parses a per-message log file (`{kind}\t{payload}\n` per onLog call)
   * into the tagged AgentLogEntry stream used by `events`-content
   * messages. Each payload may itself contain embedded newlines (a single
   * stdout write can cover multiple JSON events), so we split inside
   * each payload before parsing.
   */
  async function readLogEntries(p: string): Promise<AgentLogEntry[]> {
    let buf: string;
    try {
      buf = await fsp.readFile(p, "utf8");
    } catch {
      return [];
    }
    const entries: AgentLogEntry[] = [];
    for (const rawLine of buf.split("\n")) {
      if (!rawLine) continue;
      const tab = rawLine.indexOf("\t");
      if (tab <= 0) continue;
      const kind = rawLine.slice(0, tab);
      const payload = rawLine.slice(tab + 1);
      for (const line of payload.split("\n")) {
        if (line === "") continue;
        if (kind === "stderr") {
          entries.push({ kind: "stderr", line });
          continue;
        }
        // stdout / event: attempt to parse as JSON and validate.
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          entries.push({ kind: "unparsed", line });
          continue;
        }
        const validated = AgentEventSchema.safeParse(parsed);
        if (validated.success) {
          entries.push({ kind: "event", event: validated.data });
        } else {
          entries.push({ kind: "unparsed", line });
        }
      }
    }
    return entries;
  }

  /** Concatenates text from `text`-type agent events; falls back to any
   * `unparsed` lines so plain-string test drivers still produce output. */
  function deriveTextFromLog(entries: AgentLogEntry[]): string {
    const parts: string[] = [];
    let sawEvent = false;
    for (const e of entries) {
      if (e.kind === "event") {
        sawEvent = true;
        if (e.event.type === "text") {
          const t = e.event.part?.text;
          if (typeof t === "string") parts.push(t);
        }
      }
    }
    if (sawEvent) return parts.join("").trim();
    // No structured events — fall back to unparsed stdout lines.
    return entries
      .filter((e) => e.kind === "unparsed")
      .map((e) => (e as { line: string }).line)
      .join("\n")
      .trim();
  }

  /**
   * Returns the prompt the agent will receive plus any workspace-relative
   * attachment paths to forward to opencode via `--file`. We don't inline
   * paths into the prompt: opencode surfaces the file content directly,
   * and the picker-side path may live anywhere in the workspace, not just
   * `~/.chats/.../attachments/`.
   */
  async function derivePromptInputs(
    content: unknown,
  ): Promise<{ prompt: string; attachments?: string[] }> {
    const c = content as { type?: string; text?: string; body?: string; userMessageId?: string };
    if (c?.type === "text" && typeof c.text === "string") return { prompt: c.text };
    if (c?.type === "ai_note_request") {
      return { prompt: "Produce a coherent running summary of this chat, in markdown." };
    }
    if (c?.type === "agent_turn" && typeof c.userMessageId === "string") {
      const userMsg = await queries.messages.findById(pool, c.userMessageId);
      const inner = userMsg?.content as { type?: string; text?: string } | undefined;
      const text = inner?.type === "text" && typeof inner.text === "string" ? inner.text : "";
      const refs = userMsg?.attachments ?? [];
      const attachments = refs.length > 0 ? refs.map((a) => a.path) : undefined;
      return { prompt: text, attachments };
    }
    return { prompt: JSON.stringify(content) };
  }

  function outputContentTypeFor(triggerContent: unknown): "note" | "text" {
    const c = triggerContent as { type?: string };
    return c?.type === "ai_note_request" ? "note" : "text";
  }

  function buildOutputContent(
    kind: "note" | "text",
    entries: AgentLogEntry[],
  ): Message["content"] | null {
    if (kind === "note") {
      const body = deriveTextFromLog(entries);
      if (!body) return null;
      return { type: "note", body };
    }
    if (entries.length === 0) return null;
    return { type: "events", log: entries };
  }

  /**
   * Fires a pending scheduled message: atomically claims it (pending →
   * running), runs the agent with the message content as the prompt,
   * writes stdout/stderr to a per-message log file, and inserts a child
   * message with the output. Idempotent — concurrent fires on the same
   * messageId land on the claim check and no-op.
   */
  async function fireMessage(messageId: string): Promise<{ fired: boolean; childIds: string[] }> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return { fired: false, childIds: [] };

    const claimed = await queries.messages.claimPending(pool, messageId);
    if (!claimed) return { fired: false, childIds: [] };

    emit({
      type: "message.updated",
      payload: (await queries.messages.findById(pool, messageId))!,
    });

    const { prompt, attachments } = await derivePromptInputs(msg.content);
    const outputKind = outputContentTypeFor(msg.content);

    // Resolve the workspace slug and agent id in one JOIN'd round-trip.
    // The slug threads through the sandbox driver (mount plan, agent file,
    // chat attachments) and the per-chat log directory; extra findById
    // calls add latency that makes fire-and-forget callers racy.
    const { rows: ctxRows } = await pool.query<{
      workspace_id: string;
      workspace_path: string;
      agent_id: string;
    }>(
      `SELECT w.id AS workspace_id, w.path AS workspace_path, c.agent_id
       FROM chats c JOIN workspaces w ON w.id = c.workspace_id
       WHERE c.id = $1`,
      [msg.chatId],
    );
    const ctxRow = ctxRows[0];
    const workspaceIdPre = ctxRow?.workspace_id ?? (await firstWorkspaceId());
    const workspaceSlug = ctxRow?.workspace_path ?? "desk";
    const chatAgentIdPre = ctxRow?.agent_id;

    const logDir = await ensureLogDir(workspaceSlug, msg.chatId);
    const logFile = path.join(logDir, `${messageId}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: "a" });

    const onLog = async (evt: LogEvent) => {
      // Split on internal newlines so each log file line is exactly one
      // `kind\tpayload\n` record. A single onLog call may carry several
      // events concatenated by the driver (a stdout chunk covering
      // multiple lines); without splitting, the \n framing breaks and
      // readLogEntries can't associate continuation lines with a kind.
      for (const line of evt.payload.split("\n")) {
        logStream.write(`${evt.kind}\t${line}\n`);
      }
      emit({
        type: "message.log_appended",
        payload: { messageId, kind: evt.kind, line: evt.payload },
      });
    };

    try {
      const agentId = msg.agentId ?? chatAgentIdPre ?? (await getDefaultAgentId());
      const workspaceId = workspaceIdPre;
      const userId = await resolveUserIdForWorkspace(workspaceId);
      const userName = userId
        ? (await queries.users.findById(pool, userId))?.username ?? "User"
        : "User";
      const providerKeys = userId
        ? await queries.userSettings.getProviderKeys(pool, userId)
        : {};
      const agent = await queries.agents.findById(pool, agentId);
      const agentFileInput: AgentFileInput = {
        agentId,
        agentName: agent?.name ?? "Desk Agent",
        model: agent?.model ?? "anthropic/claude-sonnet-4-5",
        instructions: agent?.instructions ?? "",
        userName,
      };

      let result: { exitCode: number };
      if (opts.execRunFn) {
        result = await opts.execRunFn(messageId, agentId, prompt, onLog, { agentFileInput, attachments });
      } else if (process.env.DESK_SANDBOX_DRIVER === "fake") {
        const driver = createDriver();
        result = await driver.execRun(workspaceId, {
          runId: messageId,
          prompt,
          workspaceSlug,
          agentFileId: agentId,
          attachments,
          onLog,
        });
      } else {
        const home = resolveDeskHome();
        const handle = await createOrReuse(workspaceId, workspaceSlug, home, providerKeys);
        result = await runtimeExecRun(pool, handle, {
          runId: messageId,
          prompt,
          home,
          workspaceId,
          workspaceSlug,
          chatId: msg.chatId,
          agent: agentFileInput,
          attachments,
          onLog,
        });
      }

      // Wait for pending writes to flush before reading the file back.
      // Each onLog call now splits multi-line payloads into multiple
      // writes, so relying on end()'s synchronous return lets readLogEntries
      // race ahead and see only the first flushed line.
      await new Promise<void>((resolve) => {
        logStream.once("finish", resolve);
        logStream.end();
      });
      const terminal = result.exitCode === 0 ? "succeeded" : "failed";
      await queries.messages.finalizeExecution(pool, messageId, terminal);
      emit({
        type: "message.updated",
        payload: (await queries.messages.findById(pool, messageId))!,
      });

      const entries = await readLogEntries(logFile);
      const content = buildOutputContent(outputKind, entries);
      if (content) {
        // When the run produced a new note, snapshot the previous note
        // (if any) so a bad rewrite doesn't silently erase user edits.
        if (outputKind === "note") {
          const { snapshotNote } = await import("@desk/storage");
          const prev = await pool.query(
            `SELECT id, content FROM messages
             WHERE chat_id = $1 AND content->>'type' = 'note'
             ORDER BY created_at DESC LIMIT 1`,
            [msg.chatId],
          );
          if (prev.rows[0]) {
            const prevRow = prev.rows[0] as { id: string; content: { body?: string } };
            if (typeof prevRow.content.body === "string") {
              const home = resolveDeskHome();
              await snapshotNote(home, workspaceSlug, msg.chatId, prevRow.id, prevRow.content.body).catch(() => { /* best-effort */ });
            }
          }
        }

        const child = await queries.messages.insert(pool, {
          id: generateId("message"),
          chatId: msg.chatId,
          role: "agent",
          content,
          parentId: messageId,
          agentId,
          model: agentFileInput.model,
        });
        // Note-kind output: also write the body to the notes/ dir so the
        // agent (and any other filesystem consumer) can see the latest
        // note alongside its own files. Best-effort — the DB row is the
        // source of truth.
        if (content.type === "note") {
          const { materializeNote } = await import("@desk/storage");
          const home = resolveDeskHome();
          await materializeNote(home, workspaceSlug, msg.chatId, child.id, content.body).catch(() => { /* best-effort */ });
        }
        emit({ type: "message.appended", payload: child });
        return { fired: true, childIds: [child.id] };
      }
      return { fired: true, childIds: [] };
    } catch (err) {
      logStream.end();
      // eslint-disable-next-line no-console
      console.error(`fireMessage ${messageId} failed:`, err);
      await queries.messages.finalizeExecution(pool, messageId, "failed");
      emit({
        type: "message.updated",
        payload: (await queries.messages.findById(pool, messageId))!,
      });
      return { fired: true, childIds: [] };
    }
  }

  /**
   * Cancels a pending scheduled message: removes any at/cron entry it
   * owns via scheduler_ref and deletes the row. No-op if already gone.
   */
  async function cancelMessage(messageId: string): Promise<void> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return;
    const ref = msg.schedulerRef;
    if (ref) {
      try {
        if (ref.kind === "at") await adapter.removeAt(ref.id);
        else if (ref.kind === "cron") await adapter.removeCron(ref.id);
      } catch {
        // Best-effort.
      }
    }
    await pool.query("DELETE FROM messages WHERE id = $1", [messageId]);
  }

  /**
   * Schedules a new ai-note refresh for the chat: a pending system
   * ai_note_request message with an at-job that curls
   * /internal/messages/fire 30 minutes from now. Cancels any prior
   * pending ai_note_request first so there's only ever one outstanding.
   */
  async function scheduleAiNote(chatId: string): Promise<void> {
    await cancelAiNoteForChat(chatId);

    const messageId = generateId("message");
    const atTime = `now + 30 minutes`;
    const atJobId = await adapter.scheduleAt(buildMessageFireCmd(messageId), atTime);

    await queries.messages.insert(pool, {
      id: messageId,
      chatId,
      role: "system",
      content: { type: "ai_note_request" },
      state: "pending",
      executeAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      schedulerRef: { kind: "at", id: atJobId },
    });
  }

  async function cancelAiNoteForChat(chatId: string): Promise<void> {
    const { rows } = await pool.query(
      `SELECT id, scheduler_ref FROM messages
       WHERE chat_id = $1
         AND state = 'pending'
         AND content->>'type' = 'ai_note_request'`,
      [chatId],
    );
    for (const row of rows) {
      const ref = row.scheduler_ref as { kind: string; id: string } | null;
      if (ref?.kind === "at") {
        try { await adapter.removeAt(ref.id); } catch { /* ok */ }
      } else if (ref?.kind === "cron") {
        try { await adapter.removeCron(ref.id); } catch { /* ok */ }
      }
      await pool.query("DELETE FROM messages WHERE id = $1", [row.id]);
    }
  }

  async function cancelAiNote(chatId: string): Promise<void> {
    await cancelAiNoteForChat(chatId);
  }

  /** Cancels an in-flight exec: kills the opencode child if possible. */
  async function cancelRun(messageId: string): Promise<void> {
    await runtimeCancelRun(messageId);
    await queries.messages.updateMessage(pool, messageId, { state: "cancelled" });
    const msg = await queries.messages.findById(pool, messageId);
    if (msg) emit({ type: "message.updated", payload: msg });
  }

  /**
   * Pauses a pending scheduled message: removes its at/cron entry from the
   * OS scheduler, clears scheduler_ref, and transitions state to 'paused'.
   * The message row is kept so the schedule's metadata (executeAt / cron)
   * can be restored by resumeMessage. No-op if the message isn't currently
   * pending or is missing.
   */
  async function pauseMessage(messageId: string): Promise<Message | null> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return null;
    if (msg.state !== "pending") return msg;
    const ref = msg.schedulerRef;
    if (ref) {
      try {
        if (ref.kind === "at") await adapter.removeAt(ref.id);
        else if (ref.kind === "cron") await adapter.removeCron(ref.id);
      } catch {
        // Best-effort: the OS-level entry may already be gone.
      }
    }
    const updated = await queries.messages.updateMessage(pool, messageId, {
      state: "paused",
      schedulerRef: null,
    });
    if (updated) emit({ type: "message.updated", payload: updated });
    return updated;
  }

  /**
   * Resumes a paused scheduled message: re-installs the at/cron entry
   * using the message's stored executeAt/cron, writes the new
   * scheduler_ref back, and transitions state to 'pending'. For an
   * overdue at-message, the new at-job uses `now` so it fires
   * immediately on resume. No-op if the message isn't paused.
   */
  async function resumeMessage(messageId: string): Promise<Message | null> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return null;
    if (msg.state !== "paused") return msg;
    const cmd = buildMessageFireCmd(messageId);
    let newRef: { kind: "at" | "cron"; id: string } | null = null;
    if (msg.cron) {
      // One cron job per message — use the message id as the stable job id
      // so re-pauses/re-resumes don't leak stray crontab lines.
      const jobId = messageId;
      await adapter.installCron(jobId, msg.cron, cmd);
      newRef = { kind: "cron", id: jobId };
    } else if (msg.executeAt) {
      const whenMs = new Date(msg.executeAt).getTime();
      const atTime = whenMs > Date.now()
        ? new Date(whenMs).toISOString()
        : "now";
      const atJobId = await adapter.scheduleAt(cmd, atTime);
      newRef = { kind: "at", id: atJobId };
    }
    const updated = await queries.messages.updateMessage(pool, messageId, {
      state: "pending",
      schedulerRef: newRef ?? undefined,
    });
    if (updated) emit({ type: "message.updated", payload: updated });
    return updated;
  }

  /**
   * Cancels a pending scheduled message without deleting it: removes the
   * at/cron entry, clears scheduler_ref, and transitions state to
   * 'cancelled'. Used by the PATCH path so the row stays visible in the
   * chat timeline. For already-running messages this is a no-op at the
   * scheduler level but still flips the DB row.
   */
  async function cancelScheduledMessage(messageId: string): Promise<Message | null> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return null;
    const ref = msg.schedulerRef;
    if (ref) {
      try {
        if (ref.kind === "at") await adapter.removeAt(ref.id);
        else if (ref.kind === "cron") await adapter.removeCron(ref.id);
      } catch {
        // Best-effort.
      }
    }
    const updated = await queries.messages.updateMessage(pool, messageId, {
      state: "cancelled",
      schedulerRef: null,
    });
    if (updated) emit({ type: "message.updated", payload: updated });
    return updated;
  }

  return {
    fireMessage,
    cancelMessage,
    cancelRun,
    pauseMessage,
    resumeMessage,
    cancelScheduledMessage,
    scheduleAiNote,
    cancelAiNote,
    cancelAiNoteForChat,
    adapter,
  };
}
