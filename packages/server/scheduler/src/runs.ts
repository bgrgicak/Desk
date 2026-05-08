import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Cron } from "croner";
import { type Pool } from "@agent-desk/db";
import {
  generateId,
  AgentEventSchema,
  GOAL_KEYS,
  type AgentLogEntry,
  type GoalKey,
  type Message,
  type WsEvent,
} from "@agent-desk/shared";
import { queries } from "@agent-desk/db";
import { resolveDeskHome } from "@agent-desk/storage";
import {
  createOrReuse,
  execRun as runtimeExecRun,
  cancelRun as runtimeCancelRun,
  estimateMessagesTokens,
  productionReflectWorkspace,
  type LogEvent,
  type AgentFileInput,
} from "@agent-desk/runtime";
import {
  runWorkspaceReflection,
  yesterdayDateLocal,
  type ReflectFn,
  type WorkspaceReflectionInput,
} from "./reflection.js";

export interface RunManagerOptions {
  pool: Pool;
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
  /** Test-injectable replacement for the production workspace reflection call. */
  reflectWorkspace?: ReflectFn<WorkspaceReflectionInput>;
  /** DESK_HOME root. Defaults to resolveDeskHome(). */
  home?: string;
}

export interface FireMessageOptions {
  /** Manual task fires create a run now without consuming the task's schedule. */
  manual?: boolean;
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
   * Summaries should be a clean final markdown body. If the model used tools, keep
   * the last text event instead of concatenating planning chatter with the
   * final answer.
   */
  function deriveSummaryTextFromLog(entries: AgentLogEntry[]): string {
    let sawEvent = false;
    let lastText = "";
    for (const e of entries) {
      if (e.kind !== "event") continue;
      sawEvent = true;
      if (e.event.type === "text") {
        const t = e.event.part?.text;
        if (typeof t === "string" && t.trim()) lastText = t;
      }
    }
    if (lastText) return lastText.trim();
    if (sawEvent) return "";
    return entries
      .filter((e) => e.kind === "unparsed")
      .map((e) => (e as { line: string }).line)
      .join("\n")
      .trim();
  }

  const CHAT_SUMMARY_PROMPT = [
    "Refresh this chat's running summary.",
    "Return only the final markdown body; do not create files, write artifacts, or attach artifacts.",
    "Use the chat-summary format described in the agent instructions.",
  ].join("\n");

  function messageTextForPrompt(message: Message): string | null {
    const content = message.content;
    switch (content.type) {
      case "text":
        return content.text;
      case "artifactRef":
        return `Attached artifact: ${content.name ?? content.path} (${content.path})`;
      case "summary":
        return content.body;
      case "events":
        return deriveTextFromLog(content.log) || null;
      default:
        return null;
    }
  }

  function formatMessageForPrompt(message: Message): { role: string; text: string } | null {
    const text = messageTextForPrompt(message);
    const attachmentText = (message.attachments ?? [])
      .map((attachment) => `${attachment.name ?? path.basename(attachment.path)} (${attachment.path})`)
      .join(", ");
    const body = [text, attachmentText ? `Attachments: ${attachmentText}` : ""]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join("\n");
    if (!body.trim()) return null;
    const role = message.content.type === "summary"
      ? "Summary"
      : message.role === "user"
        ? "User"
        : message.role === "agent"
          ? "Agent"
          : "System";
    return {
      role,
      text: body.trim(),
    };
  }

  function shouldIncludeInPromptContext(message: Message): boolean {
    const type = message.content.type;
    if (type === "agent_turn" || type === "summary_request" || type === "reflection_request") return false;
    if (message.state === "pending" || message.state === "running") return false;
    return message.role === "user" || message.role === "agent" || type === "summary";
  }

  async function buildChatTranscriptContext(
    currentMessage: Message,
    currentUserMessageId?: string,
  ): Promise<string> {
    const items = await queries.messages.listAgentContextByChat(pool, currentMessage.chatId);
    const entries = items
      .filter((message) => message.id !== currentMessage.id && message.id !== currentUserMessageId)
      .filter(shouldIncludeInPromptContext)
      .map(formatMessageForPrompt)
      .filter((entry): entry is { role: string; text: string } => entry !== null);
    return entries.map((entry) => `${entry.role}:\n${entry.text}`).join("\n\n---\n\n");
  }

  async function withChatTranscriptContext(
    currentMessage: Message,
    prompt: string,
    currentUserMessageId?: string,
  ): Promise<string> {
    const context = await buildChatTranscriptContext(currentMessage, currentUserMessageId);
    if (!context) return prompt;
    return [
      "Chat transcript context (oldest to newest; newest summary, if any, is the compaction boundary):",
      context,
      "",
      "Current task:",
      prompt,
    ].join("\n");
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
    // Self-firing kinds (task / summary) carry the prompt directly on the
    // message — no parent lookup needed.
    if (msg.kind === "summary") {
      return { prompt: await withChatTranscriptContext(msg, CHAT_SUMMARY_PROMPT) };
    }
    if (msg.kind === "task") {
      const c = msg.content as { type?: string; text?: string };
      const text = c?.type === "text" && typeof c.text === "string" ? c.text : "";
      const refs = msg.attachments ?? [];
      const attachments = refs.length > 0 ? refs.map((a) => a.path) : undefined;
      return { prompt: await withChatTranscriptContext(msg, text), attachments };
    }
    if (msg.content.type === "reflection_request") {
      return { prompt: "Run the daily workspace memory reflection." };
    }
    const c = msg.content as { type?: string; text?: string; body?: string; userMessageId?: string };
    if (c?.type === "text" && typeof c.text === "string") {
      return { prompt: await withChatTranscriptContext(msg, c.text) };
    }
    if (c?.type === "summary_request") {
      return { prompt: await withChatTranscriptContext(msg, CHAT_SUMMARY_PROMPT) };
    }
    if (c?.type === "agent_turn" && typeof c.userMessageId === "string") {
      const userMsg = await queries.messages.findById(pool, c.userMessageId);
      const inner = userMsg?.content as { type?: string; text?: string } | undefined;
      const text = inner?.type === "text" && typeof inner.text === "string" ? inner.text : "";
      const refs = userMsg?.attachments ?? [];
      const attachments = refs.length > 0 ? refs.map((a) => a.path) : undefined;
      return { prompt: await withChatTranscriptContext(msg, text, c.userMessageId), attachments };
    }
    const fallback = JSON.stringify(msg.content);
    return { prompt: await withChatTranscriptContext(msg, fallback) };
  }

  function currentUserMessageIdForGoalAutodetectGate(msg: Message): string | null {
    const c = msg.content as { type?: string; userMessageId?: string };
    if (c?.type === "agent_turn" && typeof c.userMessageId === "string") return c.userMessageId;
    return msg.role === "user" ? msg.id : null;
  }

  async function isFirstUserMessageInChat(chatId: string, userMessageId: string): Promise<boolean> {
    const { rows } = await pool.query(
      `SELECT 1
       FROM messages m
       WHERE m.id = ?
         AND m.chat_id = ?
         AND m.role = 'user'
         AND NOT EXISTS (
           SELECT 1
           FROM messages prior
           WHERE prior.chat_id = m.chat_id
             AND prior.role = 'user'
             AND prior.id <> m.id
             AND (
               prior.created_at < m.created_at
               OR (prior.created_at = m.created_at AND prior.id < m.id)
             )
         )
       LIMIT 1`,
      [userMessageId, chatId],
    );
    return rows.length > 0;
  }

  function outputContentTypeFor(msg: Message): "summary" | "text" {
    if (msg.kind === "summary") return "summary";
    const c = msg.content as { type?: string };
    return c?.type === "summary_request" ? "summary" : "text";
  }

  function buildOutputContent(
    kind: "summary" | "text",
    entries: AgentLogEntry[],
  ): Message["content"] | null {
    if (kind === "summary") {
      const body = deriveSummaryTextFromLog(entries);
      if (!body) return null;
      return { type: "summary", body };
    }
    if (entries.length === 0) return null;
    return { type: "events", log: entries };
  }

  function errorLogLines(err: unknown): string[] {
    const message = err instanceof Error ? err.message : String(err);
    return [
      "Agent run failed before it could complete.",
      message,
    ].filter((line) => line.trim().length > 0);
  }

  async function fireReflectionTask(
    msg: Message,
    workspaceId: string,
    workspaceSlug: string,
    workspaceName: string,
    userId: string | null,
    userName: string,
    userTimezone: string | undefined,
    manual: boolean,
  ): Promise<string | null> {
    const c = msg.content as { type?: string; workspaceId?: string };
    if (c.type !== "reflection_request" || c.workspaceId !== workspaceId) {
      throw new Error("reflection request does not match its chat workspace");
    }
    const agentId = msg.agentId ?? (await getDefaultAgentId());
    const agent = await queries.agents.findById(pool, agentId);
    if (!agent) throw new Error(`Reflection agent not found: ${agentId}`);
    const providerKeys = userId
      ? await queries.userSettings.getProviderKeys(pool, userId)
      : {};
    return await runWorkspaceReflection({
      pool,
      home: opts.home ?? resolveDeskHome(),
      date: yesterdayDateLocal(),
      workspaceId,
      workspaceSlug,
      workspaceName,
      userId: userId ?? "",
      userName,
      userTimezone,
      agent: { id: agent.id, name: agent.name, model: agent.model },
      providerKeys,
      reflectWorkspace: opts.reflectWorkspace ?? productionReflectWorkspace,
      reflectOnEmptyActivity: manual,
    });
  }

  async function logReflectionOutcome(runId: string, body: string | null, onLog: (evt: LogEvent) => void | Promise<void>): Promise<void> {
    const text = body === null
      ? "Daily workspace reflection skipped: no activity found for the reflection date."
      : "Daily workspace reflection completed.";
    await onLog({
      runId,
      seq: 0,
      kind: "stdout",
      payload: JSON.stringify({ type: "text", part: { text } }),
    });
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
   *   - `chat` / `summary`: claims the message itself (pending → running)
   *     and finalises it in place. Idempotent on `messageId` — these
   *     kinds fire once per row (a fresh row per chat agent_turn or per
   *     scheduleSummary refresh).
   *
   * Returns `fired: false` if the row is missing, the kind doesn't fire,
   * or another fire is already in flight (the task lock declined us).
   */
  async function fireMessage(messageId: string, fireOptions: FireMessageOptions = {}): Promise<{ fired: boolean; childIds: string[] }> {
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

    // Single JOIN resolves workspace slug, agent, user, timezone, and the
    // chat's persistent goal in one round-trip. `chat_goal` feeds the
    // per-chat goal fragment into the rendered system prompt.
    const { rows: ctxRows } = await pool.query<{
      workspace_id: string;
      workspace_path: string;
      workspace_name: string;
      agent_id: string | null;
      user_id: string | null;
      username: string | null;
      timezone: string | null;
      chat_goal: string | null;
    }>(
      `SELECT w.id AS workspace_id, w.path AS workspace_path, w.name AS workspace_name, c.agent_id,
              u.id AS user_id, u.username, u.timezone,
              c.goal AS chat_goal
       FROM chats c
       JOIN workspaces w ON w.id = c.workspace_id
       LEFT JOIN users u ON u.id = w.user_id
       WHERE c.id = ?`,
      [msg.chatId],
    );
    const ctxRow = ctxRows[0];
    const workspaceId = ctxRow?.workspace_id ?? (await firstWorkspaceId());
    const workspaceSlug = ctxRow?.workspace_path ?? "desk";
    const workspaceName = ctxRow?.workspace_name ?? workspaceSlug;
    const chatAgentId = ctxRow?.agent_id ?? null;
    const userId = ctxRow?.user_id ?? null;
    const userName = ctxRow?.username ?? "User";
    const userTimezone = ctxRow?.timezone ?? undefined;
    // Validate against the known goal keys before treating the column as a
    // GoalKey: if a row holds a value outside GOAL_KEYS (legacy data, manual
    // SQL edit), `goal/<key>.md` would not exist and the run would crash on
    // ENOENT mid-render. Fall back to no goal in that case.
    const rawGoal = ctxRow?.chat_goal ?? null;
    const chatGoal: GoalKey | null =
      rawGoal !== null && (GOAL_KEYS as readonly string[]).includes(rawGoal)
        ? (rawGoal as GoalKey)
        : null;

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
      const userMessageIdForGoalGate = currentUserMessageIdForGoalAutodetectGate(msg);
      const includeGoalAutodetect = chatGoal && userMessageIdForGoalGate
        ? !(await isFirstUserMessageInChat(msg.chatId, userMessageIdForGoalGate))
        : true;
      const agentFileInput: AgentFileInput = {
        agentId,
        agentName: agent?.name ?? "Desk Agent",
        model: agent?.model ?? "opencode/big-pickle",
        userName,
        userTimezone,
        chatId: msg.chatId,
        goal: chatGoal,
        includeGoalAutodetect,
        runMode: outputKind === "summary" ? "summary" : "chat",
      };

      let result: { exitCode: number };
      if (opts.execRunFn) {
        result = await opts.execRunFn(runId, agentId, prompt, onLog, { agentFileInput, attachments });
      } else {
        const home = resolveDeskHome();
        if (msg.content.type === "reflection_request") {
          const reflected = await fireReflectionTask(
            msg,
            workspaceId,
            workspaceSlug,
            workspaceName,
            userId,
            userName,
            userTimezone,
            fireOptions.manual === true,
          );
          await logReflectionOutcome(runId, reflected, onLog);
          result = { exitCode: 0 };
        } else {
          const handle = process.env.DESK_SANDBOX_DRIVER === "fake"
          ? { containerId: "fake-sandbox", workspaceId }
          : await createOrReuse(workspaceId, workspaceSlug, home, providerKeys);
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
      await afterTaskRun(msg, terminal, fireOptions);

      const entries = await readLogEntries(logFile);
      const content = buildOutputContent(outputKind, entries);
      if (content) {
        // When the run produced a new summary, snapshot the previous summary
        // (if any) so a bad rewrite doesn't silently erase user edits.
        if (outputKind === "summary") {
          const { snapshotSummary } = await import("@agent-desk/storage");
          const prev = await pool.query(
            `SELECT id, content FROM messages
             WHERE chat_id = ? AND json_extract(content, '$.type') = 'summary'
             ORDER BY created_at DESC LIMIT 1`,
            [msg.chatId],
          );
          if (prev.rows[0]) {
            // SQLite returns JSON columns as TEXT; parse before reading.
            const prevRow = prev.rows[0] as { id: string; content: string };
            const parsed = JSON.parse(prevRow.content) as { body?: string };
            if (typeof parsed.body === "string") {
              const home = resolveDeskHome();
              await snapshotSummary(home, workspaceSlug, msg.chatId, prevRow.id, parsed.body).catch(() => { /* best-effort */ });
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
        // Summary output: also write the body to the notes/ dir so the
        // agent (and any other filesystem consumer) can see the latest
        // summary alongside its own files. Best-effort — the DB row is the
        // source of truth.
        if (content.type === "summary") {
          const { materializeSummary } = await import("@agent-desk/storage");
          const home = resolveDeskHome();
          await materializeSummary(home, workspaceSlug, msg.chatId, child.id, content.body).catch(() => { /* best-effort */ });
        }
        emit({ type: "message.appended", payload: child });
        emit({ type: "workspace.synced", payload: { workspaceId } });
        return { fired: true, childIds: [child.id] };
      }
      emit({ type: "workspace.synced", payload: { workspaceId } });
      return { fired: true, childIds: [] };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`fireMessage ${messageId} failed:`, err);
      for (const line of errorLogLines(err)) {
        await onLog({ runId, seq: 0, kind: "stderr", payload: line });
      }
      await new Promise<void>((resolve) => {
        logStream.once("finish", resolve);
        logStream.end();
      });
      await queries.messages.finalizeExecution(pool, runId, "failed");
      emit({
        type: "message.updated",
        payload: (await queries.messages.findById(pool, runId))!,
      });
      await afterTaskRun(msg, "failed", fireOptions);
      const entries = await readLogEntries(logFile);
      const content = buildOutputContent("text", entries);
      if (!content) {
        return { fired: true, childIds: [] };
      }
      const child = await queries.messages.insert(pool, {
        id: generateId("message"),
        chatId: msg.chatId,
        role: "agent",
        content,
        parentId: runId,
      });
      emit({ type: "message.appended", payload: child });
      emit({ type: "workspace.synced", payload: { workspaceId } });
      return { fired: true, childIds: [child.id] };
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
    fireOptions: FireMessageOptions = {},
  ): Promise<void> {
    if (task.kind !== "task") return;
    if (fireOptions.manual && (task.executeAt || task.cron)) {
      const result = await pool.query(
        `UPDATE messages
         SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND state = 'running'`,
        [task.state, task.id],
      );
      if ((result.rowCount ?? 0) > 0) {
        const updated = await queries.messages.findById(pool, task.id);
        if (updated) emit({ type: "message.updated", payload: updated });
      }
      const latest = await queries.messages.findById(pool, task.id);
      if (latest?.state === "pending" && latest.cron && !latest.executeAt) {
        const updated = await queries.messages.updateMessage(pool, task.id, {
          executeAt: computeNextRun(latest.cron),
        });
        if (updated) emit({ type: "message.updated", payload: updated });
      }
      return;
    }
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
         AND execute_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ORDER BY execute_at
       LIMIT ?`,
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

  /** Permanently deletes a message row. Used for ephemeral rows (e.g. summary) that should leave no trace. */
  async function cancelMessage(messageId: string): Promise<void> {
    await pool.query("DELETE FROM messages WHERE id = ?", [messageId]);
  }

  /**
   * Hybrid summary trigger (memory-system spec, P2.2).
   *
   * Counts tokens in the transcript-since-last-summary; if the token
   * budget breaches `SUMMARY_TRIGGER_FRACTION` of the model context
   * window, fire the summary immediately (executeAt = now). Otherwise
   * the existing time-based 30-minute fallback applies.
   *
   * The model context window defaults to 200_000 tokens (Claude
   * Sonnet/Opus and most modern frontier models) and can be overridden
   * via `DESK_SUMMARY_MODEL_CONTEXT_WINDOW`. The fraction can be
   * overridden via `DESK_SUMMARY_TRIGGER_FRACTION` (default `0.6`).
   */
  async function scheduleSummary(chatId: string): Promise<void> {
    await cancelSummaryForChat(chatId);
    const urgent = await isSummaryBudgetExceeded(chatId);
    const executeAt = urgent
      ? new Date().toISOString()
      : new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const messageId = generateId("message");
    await queries.messages.insert(pool, {
      id: messageId,
      chatId,
      role: "system",
      content: { type: "summary_request" },
      state: "pending",
      kind: "summary",
      executeAt,
    });
  }

  function summaryModelContextWindow(): number {
    const fromEnv = Number.parseInt(
      process.env.DESK_SUMMARY_MODEL_CONTEXT_WINDOW ?? "",
      10,
    );
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 200_000;
  }

  function summaryTriggerFraction(): number {
    const fromEnv = Number.parseFloat(process.env.DESK_SUMMARY_TRIGGER_FRACTION ?? "");
    return Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 1 ? fromEnv : 0.6;
  }

  async function isSummaryBudgetExceeded(chatId: string): Promise<boolean> {
    const items = await queries.messages.listAgentContextByChat(pool, chatId);
    const tokenized = items
      .filter(shouldIncludeInPromptContext)
      .map((m) => {
        const formatted = formatMessageForPrompt(m);
        return formatted ? { role: formatted.role, text: formatted.text } : null;
      })
      .filter((m): m is { role: string; text: string } => m !== null);
    const used = estimateMessagesTokens(tokenized);
    const budget = Math.floor(summaryModelContextWindow() * summaryTriggerFraction());
    return used >= budget;
  }

  async function cancelSummaryForChat(chatId: string): Promise<void> {
    await pool.query(
      `DELETE FROM messages WHERE chat_id = ? AND kind = 'summary' AND state = 'pending'`,
      [chatId],
    );
  }

  async function cancelSummary(chatId: string): Promise<void> {
    await cancelSummaryForChat(chatId);
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
    if (msg.state === "pending") return msg;
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
    scheduleSummary,
    cancelSummary,
    cancelSummaryForChat,
  };
}
