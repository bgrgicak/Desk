import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import pg from "pg";
import { Cron } from "croner";
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

export interface RunManagerOptions {
  pool: pg.Pool;
  emit?: (event: WsEvent) => void;
  /**
   * Test-injectable replacement for the runtime's opencode spawn. Called
   * by fireMessage with the run id. Return the exit code; the scheduler
   * handles state transitions and child-message insertion.
   */
  execRunFn?: (
    messageId: string,
    agentId: string,
    prompt: string,
    onLog: (evt: LogEvent) => void | Promise<void>,
    opts?: { agentFileInput: AgentFileInput; attachments?: string[] },
  ) => Promise<{ exitCode: number }>;
}

function computeNextRun(cronExpr: string): string {
  const next = new Cron(cronExpr).nextRun();
  if (!next) throw new Error(`cron expression "${cronExpr}" has no future occurrences`);
  return next.toISOString();
}

export function createRunManager(opts: RunManagerOptions) {
  const { pool, emit = () => {} } = opts;

  let inFlight = 0;
  const MAX_CONCURRENT = parseInt(process.env.DESK_SCHEDULER_MAX_CONCURRENT ?? "3", 10);

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
      // Emit parent task update so the kanban moves the card to Active.
      const updatedTask = await queries.messages.findById(pool, messageId);
      if (updatedTask) emit({ type: "message.updated", payload: updatedTask });
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

    // Single JOIN resolves workspace slug, agent, user, and timezone in one round-trip.
    const { rows: ctxRows } = await pool.query<{
      workspace_id: string;
      workspace_path: string;
      agent_id: string | null;
      user_id: string | null;
      username: string | null;
      timezone: string | null;
    }>(
      `SELECT w.id AS workspace_id, w.path AS workspace_path, c.agent_id,
              u.id AS user_id, u.username, u.timezone
       FROM chats c
       JOIN workspaces w ON w.id = c.workspace_id
       LEFT JOIN users u ON u.id = w.user_id
       WHERE c.id = $1`,
      [msg.chatId],
    );
    const ctxRow = ctxRows[0];
    const workspaceId = ctxRow?.workspace_id ?? (await firstWorkspaceId());
    const workspaceSlug = ctxRow?.workspace_path ?? "desk";
    const chatAgentId = ctxRow?.agent_id ?? null;
    const userId = ctxRow?.user_id ?? null;
    const userName = ctxRow?.username ?? "User";
    const userTimezone = ctxRow?.timezone ?? undefined;

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
      const agentId = msg.agentId ?? chatAgentId ?? (await getDefaultAgentId());
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
      await afterTaskRun(msg, terminal);

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
      await afterTaskRun(msg, "failed");
      return { fired: true, childIds: [] };
    }
  }

  /**
   * After a task run completes: cron tasks advance execute_at to the next
   * occurrence and stay pending; one-shot tasks transition to the terminal
   * state and clear execute_at.
   */
  async function afterTaskRun(
    task: Message,
    terminal: "succeeded" | "failed" | "cancelled",
  ): Promise<void> {
    if (task.kind !== "task") return;
    if (task.cron) {
      const nextRun = computeNextRun(task.cron);
      const updated = await queries.messages.updateMessage(pool, task.id, { state: "pending", executeAt: nextRun });
      if (updated) emit({ type: "message.updated", payload: updated });
      return;
    }
    // User-created unscheduled tasks: the user owns their status. Leave
    // the parent at 'running' so the card stays in the Active column.
    if (task.role === "user" && !task.executeAt) return;
    const updated = await queries.messages.updateMessage(pool, task.id, {
      state: terminal,
      executeAt: null,
    });
    if (updated) emit({ type: "message.updated", payload: updated });
  }

  /**
   * Polls for due pending messages and fires them up to MAX_CONCURRENT at a time.
   * Awaits all fires so callers (and tests) get a consistent DB state on return.
   */
  async function tickScheduled(): Promise<void> {
    const available = MAX_CONCURRENT - inFlight;
    if (available <= 0) return;
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE state = 'pending'
         AND execute_at IS NOT NULL
         AND execute_at <= now()
       ORDER BY execute_at
       LIMIT $1`,
      [available],
    );
    await Promise.all(
      rows.map((row) => {
        inFlight++;
        return fireMessage(row.id)
          .catch((err: unknown) => {
            console.error(`fireMessage ${row.id} failed:`, err);
          })
          .finally(() => {
            inFlight--;
          });
      }),
    );
  }

  function startPolling(intervalMs: number): NodeJS.Timeout {
    const timer = setInterval(() => { void tickScheduled(); }, intervalMs);
    timer.unref();
    return timer;
  }

  /** Permanently deletes a message row. Used for ephemeral rows (e.g. ai_note) that should leave no trace. */
  async function cancelMessage(messageId: string): Promise<void> {
    await pool.query("DELETE FROM messages WHERE id = $1", [messageId]);
  }

  /** Schedules an ai_note refresh for the chat, deleting any prior ai_note rows first. */
  async function scheduleAiNote(chatId: string): Promise<void> {
    await cancelAiNoteForChat(chatId);
    const messageId = generateId("message");
    await queries.messages.insert(pool, {
      id: messageId,
      chatId,
      role: "system",
      content: { type: "ai_note_request" },
      state: "pending",
      kind: "ai_note",
      executeAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
  }

  async function cancelAiNoteForChat(chatId: string): Promise<void> {
    await pool.query(
      `DELETE FROM messages WHERE chat_id = $1 AND kind = 'ai_note'`,
      [chatId],
    );
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

  /** Pauses a pending scheduled message: transitions state to 'paused'. */
  async function pauseMessage(messageId: string): Promise<Message | null> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return null;
    if (msg.state !== "pending") return msg;
    const updated = await queries.messages.updateMessage(pool, messageId, { state: "paused" });
    if (updated) emit({ type: "message.updated", payload: updated });
    return updated;
  }

  /**
   * Resumes a non-running message back to 'pending'. For cron tasks without
   * an execute_at, computes the next run time. Source state can be paused,
   * cancelled, succeeded, or failed; no-op only if already running or pending.
   */
  async function resumeMessage(messageId: string): Promise<Message | null> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return null;
    if (msg.state === "running" || msg.state === "pending") return msg;
    const patch: Parameters<typeof queries.messages.updateMessage>[2] = { state: "pending" };
    if (msg.cron && !msg.executeAt) {
      patch.executeAt = computeNextRun(msg.cron);
    }
    const updated = await queries.messages.updateMessage(pool, messageId, patch);
    if (updated) emit({ type: "message.updated", payload: updated });
    return updated;
  }

  /**
   * Reconciles the execute_at/cron after a PATCH that mutates schedule without
   * crossing a state boundary. For cron tasks, recomputes the next run time.
   */
  async function rescheduleMessage(messageId: string): Promise<Message | null> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return null;
    if (msg.state !== "pending") return msg;
    if (msg.cron) {
      const nextRun = computeNextRun(msg.cron);
      const updated = await queries.messages.updateMessage(pool, messageId, { executeAt: nextRun });
      if (updated) emit({ type: "message.updated", payload: updated });
      return updated;
    }
    const updated = await queries.messages.findById(pool, messageId);
    if (updated) emit({ type: "message.updated", payload: updated });
    return updated;
  }

  /**
   * Cancels a pending scheduled message without deleting it: transitions state
   * to 'cancelled' so the row stays visible in the chat timeline.
   */
  async function cancelScheduledMessage(messageId: string): Promise<Message | null> {
    const msg = await queries.messages.findById(pool, messageId);
    if (!msg) return null;
    const updated = await queries.messages.updateMessage(pool, messageId, { state: "cancelled" });
    if (updated) emit({ type: "message.updated", payload: updated });
    return updated;
  }

  return {
    fireMessage,
    tickScheduled,
    startPolling,
    cancelMessage,
    cancelRun,
    pauseMessage,
    resumeMessage,
    rescheduleMessage,
    cancelScheduledMessage,
    scheduleAiNote,
    cancelAiNote,
    cancelAiNoteForChat,
  };
}
