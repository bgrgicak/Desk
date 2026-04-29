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
import { resolveDeskHome, workspaceRootPath } from "@desk/storage";
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
    msg: Message,
  ): Promise<{ prompt: string; attachments?: string[] }> {
    // Self-firing kinds (task / ai_note) carry the prompt directly on the
    // message — no parent lookup needed.
    if (msg.kind === "ai_note") {
      return { prompt: "Produce a coherent running summary of this chat, in markdown." };
    }
    if (msg.kind === "task") {
      const c = msg.content as { type?: string; text?: string };
      const text = c?.type === "text" && typeof c.text === "string" ? c.text : "";
      const refs = msg.attachments ?? [];
      const attachments = refs.length > 0 ? refs.map((a) => a.path) : undefined;
      return { prompt: text, attachments };
    }
    const c = msg.content as { type?: string; text?: string; body?: string; userMessageId?: string };
    if (c?.type === "text" && typeof c.text === "string") return { prompt: c.text };
    if (c?.type === "ai_note_request") {
      return { prompt: "Produce a coherent running summary of this chat, in markdown." };
    }
    if (c?.type === "agent_turn" && typeof c.userMessageId === "string") {
      const userMsg = await queries.messages.findById(pool, c.userMessageId);
      const inner = userMsg?.content as { type?: string; text?: string; goal?: string } | undefined;
      const text = inner?.type === "text" && typeof inner.text === "string" ? inner.text : "";
      const refs = userMsg?.attachments ?? [];
      const attachments = refs.length > 0 ? refs.map((a) => a.path) : undefined;
      const prompt = inner?.goal ? `Goal: ${inner.goal}\n\n${text}` : text;
      return { prompt, attachments };
    }
    return { prompt: JSON.stringify(msg.content) };
  }

  function outputContentTypeFor(msg: Message): "note" | "text" {
    if (msg.kind === "ai_note") return "note";
    const c = msg.content as { type?: string };
    return c?.type === "ai_note_request" ? "note" : "text";
  }

  /**
   * Walks the workspace root for files whose mtime is at or after `since`.
   * Returns workspace-relative paths (forward slashes). Skips dotfiles so
   * agent infrastructure (.chats/, .opencode/, etc.) is excluded — matching
   * the same rule as listLibrary.
   */
  async function touchedLibraryPaths(workspaceRoot: string, since: Date): Promise<string[]> {
    const sinceMs = since.getTime();
    const result: string[] = [];
    const stack = [workspaceRoot];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(abs);
        } else if (entry.isFile()) {
          const stat = await fsp.stat(abs).catch(() => null);
          if (stat && stat.mtimeMs >= sinceMs) {
            result.push(path.relative(workspaceRoot, abs).split(path.sep).join("/"));
          }
        }
      }
    }
    return result;
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
   * Fires a scheduled message. Behaviour branches on `kind`:
   *
   *   - `task`: inserts a fresh `task_run` child of the task and runs the
   *     agent against it. The task definition is *not* mutated through
   *     pending → running — it stays as the schedule. Each fire produces
   *     a new run row with its own state/started_at/ended_at, so a cron
   *     task accumulates a real run history. Concurrent fires of the same
   *     task converge in `startTaskRun` (locks the task, refuses if a run
   *     is already in flight). One-shot tasks (executeAt, no cron) also
   *     transition the parent definition to mirror the run's terminal
   *     state and clear executeAt once the run completes — so they leave
   *     the "scheduled" column.
   *
   *   - `chat` / `ai_note`: claims the message itself (pending → running)
   *     and finalises it in place. Idempotent on `messageId` — these
   *     kinds fire once per row (a fresh row per chat agent_turn or per
   *     scheduleAiNote refresh).
   *
   * Returns `fired: false` if the row is missing, the kind doesn't fire,
   * or another fire is already in flight (the task lock declined us).
   */
  async function fireMessage(messageId: string): Promise<{ fired: boolean; childIds: string[] }> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return { fired: false, childIds: [] };

    // Execution target: the row whose state/started_at/ended_at this fire
    // owns. For a task, it's a freshly-inserted task_run child; for other
    // kinds, it's the message itself.
    let runId: string;
    if (msg.kind === "task") {
      const newRunId = generateId("message");
      const run = await queries.messages.startTaskRun(pool, {
        runId: newRunId,
        taskId: messageId,
        chatId: msg.chatId,
        role: msg.role,
        content: msg.content,
        agentId: msg.agentId ?? null,
        model: msg.model ?? null,
      });
      if (!run) return { fired: false, childIds: [] };
      runId = run.id;
      emit({ type: "message.appended", payload: run });
    } else {
      const claimed = await queries.messages.claimPending(pool, messageId);
      if (!claimed) return { fired: false, childIds: [] };
      runId = messageId;
      emit({
        type: "message.updated",
        payload: (await queries.messages.findById(pool, messageId))!,
      });
    }

    const { prompt, attachments } = await derivePromptInputs(msg);
    const outputKind = outputContentTypeFor(msg);

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
    const logFile = path.join(logDir, `${runId}.log`);
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
        payload: { messageId: runId, kind: evt.kind, line: evt.payload },
      });
    };

    try {
      const agentId = msg.agentId ?? chatAgentIdPre ?? (await getDefaultAgentId());
      const workspaceId = workspaceIdPre;
      const userId = await resolveUserIdForWorkspace(workspaceId);
      const userRow = userId ? await queries.users.findById(pool, userId) : null;
      const userName = userRow?.username ?? "User";
      const userTimezone = userRow?.timezone;
      const providerKeys = userId
        ? await queries.userSettings.getProviderKeys(pool, userId)
        : {};
      if (userId && Object.keys(providerKeys).length > 0) {
        await queries.providerKeyAccessLog.logKeyAccess(
          pool, userId, "read", Object.keys(providerKeys), `sandbox_run:${runId}`,
        );
      }
      const agent = await queries.agents.findById(pool, agentId);
      const agentFileInput: AgentFileInput = {
        agentId,
        agentName: agent?.name ?? "Desk Agent",
        model: agent?.model ?? "opencode/big-pickle",
        instructions: agent?.instructions ?? "",
        userName,
        userTimezone,
      };

      const runStart = new Date();
      let result: { exitCode: number };
      if (opts.execRunFn) {
        result = await opts.execRunFn(runId, agentId, prompt, onLog, { agentFileInput, attachments });
      } else if (process.env.DESK_SANDBOX_DRIVER === "fake") {
        const driver = createDriver();
        result = await driver.execRun(workspaceId, {
          runId,
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
          runId,
          prompt,
          home,
          workspaceId,
          workspaceSlug,
          chatId: msg.chatId,
          agent: agentFileInput,
          attachments,
          providerKeys,
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
      await queries.messages.finalizeExecution(pool, runId, terminal);
      emit({
        type: "message.updated",
        payload: (await queries.messages.findById(pool, runId))!,
      });
      await finalizeTaskDefinitionIfOneShot(msg, terminal);

      // Best-effort: record which files this agent touched so the library UI
      // can show real agent names on artifact cards.
      const wsRoot = workspaceRootPath(resolveDeskHome(), workspaceSlug);
      touchedLibraryPaths(wsRoot, runStart).then((touched) =>
        queries.libraryFileAuthors.upsertAuthors(pool, workspaceId, agentId, touched),
      ).catch(() => { /* best-effort */ });

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
          parentId: runId,
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
      await queries.messages.finalizeExecution(pool, runId, "failed");
      emit({
        type: "message.updated",
        payload: (await queries.messages.findById(pool, runId))!,
      });
      await finalizeTaskDefinitionIfOneShot(msg, "failed");
      return { fired: true, childIds: [] };
    }
  }

  /**
   * One-shot task (executeAt set, no cron): once its single run terminates,
   * the task definition itself transitions to mirror the run's outcome and
   * clears executeAt — moving it out of the "scheduled" column on the
   * Tasks page. Cron tasks always stay scheduled (their schedule is the
   * point); chat / ai_note kinds don't go through this path.
   */
  async function finalizeTaskDefinitionIfOneShot(
    task: Message,
    terminal: "succeeded" | "failed" | "cancelled",
  ): Promise<void> {
    if (task.kind !== "task") return;
    if (task.cron) return;
    await queries.messages.updateMessage(pool, task.id, {
      state: terminal,
      executeAt: null,
    });
    const updated = await queries.messages.findById(pool, task.id);
    if (updated) emit({ type: "message.updated", payload: updated });
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
      kind: "ai_note",
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
   * Resumes a non-running message back to 'pending': re-installs the
   * at/cron entry using the message's stored executeAt/cron, writes the
   * new scheduler_ref back, and transitions state to 'pending'. For an
   * overdue at-message, the new at-job uses `now` so it fires
   * immediately on resume. If neither executeAt nor cron is set the row
   * just flips to pending with no scheduler entry — that's the kanban
   * "Complete → Todo" path, where executeAt was already cleared by the
   * patch handler before we get here. Source state can be paused,
   * cancelled, succeeded, or failed (the kanban Complete column maps to
   * any of those); we no-op only if it's already running or pending.
   */
  async function resumeMessage(messageId: string): Promise<Message | null> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return null;
    if (msg.state === "running" || msg.state === "pending") return msg;
    // A stale ref can be present on a cancelled row in theory (cancel
    // clears it, but a future code path might not). Remove it before
    // reinstalling so we never leak two at-jobs for one message.
    const existing = msg.schedulerRef;
    if (existing) {
      try {
        if (existing.kind === "at") await adapter.removeAt(existing.id);
        else if (existing.kind === "cron") await adapter.removeCron(existing.id);
      } catch {
        // Best-effort.
      }
    }
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
      schedulerRef: newRef,
    });
    if (updated) emit({ type: "message.updated", payload: updated });
    return updated;
  }

  /**
   * Installs the at/cron entry for a freshly inserted self-firing message
   * (kind='task' / 'ai_note' with executeAt or cron set). Stamps
   * scheduler_ref on the row. Idempotent: if a ref already exists, it's
   * removed first so callers can retry. Used by the POST /chats/:id/messages
   * handler when the inserted row already carries its schedule.
   */
  async function scheduleMessage(messageId: string): Promise<Message | null> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return null;
    if (!msg.executeAt && !msg.cron) return msg;
    const existing = msg.schedulerRef;
    if (existing) {
      try {
        if (existing.kind === "at") await adapter.removeAt(existing.id);
        else if (existing.kind === "cron") await adapter.removeCron(existing.id);
      } catch {
        // Best-effort.
      }
    }
    const cmd = buildMessageFireCmd(messageId);
    let ref: { kind: "at" | "cron"; id: string } | null = null;
    if (msg.cron) {
      await adapter.installCron(messageId, msg.cron, cmd);
      ref = { kind: "cron", id: messageId };
    } else if (msg.executeAt) {
      const whenMs = new Date(msg.executeAt).getTime();
      const atTime = whenMs > Date.now()
        ? new Date(whenMs).toISOString()
        : "now";
      const atJobId = await adapter.scheduleAt(cmd, atTime);
      ref = { kind: "at", id: atJobId };
    }
    const updated = await queries.messages.updateMessage(pool, messageId, {
      state: "pending",
      schedulerRef: ref ?? undefined,
    });
    if (updated) emit({ type: "message.updated", payload: updated });
    return updated;
  }

  /**
   * Reconciles the OS-level at/cron entry with the row's current state +
   * schedule. Called after a PATCH that mutates executeAt/cron without
   * crossing a state boundary (e.g. kanban "Scheduled → Todo" clears
   * executeAt but leaves state='pending'). Always removes the existing
   * scheduler_ref entry; re-installs only if state='pending' and a
   * schedule remains. No-op for terminal rows.
   */
  async function rescheduleMessage(messageId: string): Promise<Message | null> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return null;
    const existing = msg.schedulerRef;
    if (existing) {
      try {
        if (existing.kind === "at") await adapter.removeAt(existing.id);
        else if (existing.kind === "cron") await adapter.removeCron(existing.id);
      } catch {
        // Best-effort.
      }
    }
    let newRef: { kind: "at" | "cron"; id: string } | null = null;
    if (msg.state === "pending") {
      const cmd = buildMessageFireCmd(messageId);
      if (msg.cron) {
        await adapter.installCron(messageId, msg.cron, cmd);
        newRef = { kind: "cron", id: messageId };
      } else if (msg.executeAt) {
        const whenMs = new Date(msg.executeAt).getTime();
        const atTime = whenMs > Date.now()
          ? new Date(whenMs).toISOString()
          : "now";
        const atJobId = await adapter.scheduleAt(cmd, atTime);
        newRef = { kind: "at", id: atJobId };
      }
    }
    const updated = await queries.messages.updateMessage(pool, messageId, {
      schedulerRef: newRef,
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
    scheduleMessage,
    rescheduleMessage,
    cancelScheduledMessage,
    scheduleAiNote,
    cancelAiNote,
    cancelAiNoteForChat,
    adapter,
  };
}
