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
  buildDefaultMountPlan,
  createOrReuse,
  execRun as runtimeExecRun,
  classifyResourceError,
  growSandboxForResourceError,
  reapIdleSandboxes,
  cancelRun as runtimeCancelRun,
  estimateMessagesTokens,
  listModels,
  productionReflectWorkspace,
  resolveLocalSourceEnv,
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
   * Resolves the active provider API keys for a given user/workspace. Injected
   * by the API layer (which owns the vault) so the scheduler doesn't need to
   * import VaultStore directly. Returns an empty object when unavailable.
   */
  resolveProviderKeys?: (userId: string, workspaceId?: string) => Promise<Record<string, string>>;
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
  /** Test hook for model metadata used by the adaptive summary trigger. */
  summaryModelContextWindowFn?: (chatId: string, modelId: string) => Promise<number | SummaryModelTokenLimits | null>;
}

interface SummaryModelTokenLimits {
  contextWindow: number;
  inputLimit?: number;
  outputLimit?: number;
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
  const home = opts.home ?? resolveDeskHome();
  const resolveProviderKeys = opts.resolveProviderKeys ?? (() => Promise.resolve({}));
  const modelContextCache = new Map<string, { expiresAt: number; values: Map<string, SummaryModelTokenLimits> }>();

  let inFlight = 0;
  const MAX_CONCURRENT = parseInt(process.env.DESK_SCHEDULER_MAX_CONCURRENT ?? "10", 10);

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
    const dir = path.join(home, workspaceSlug, ".chats", chatId, "logs");
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

  function shouldIncludeInPromptContext(message: Message, taskRunParentIds: Set<string> = new Set()): boolean {
    const type = message.content.type;
    if (type === "agent_turn" || type === "summary_request" || type === "reflection_request") return false;
    // Scheduled task definitions and their run children are operational records,
    // not conversational turns. If included as normal Agent/User transcript text,
    // a later agent run can misread an old task as a fresh instruction and
    // schedule it again.
    if (message.kind === "task" || message.kind === "task_run") return false;
    // Task run output is stored as a normal agent chat child under the task_run
    // row, so exclude those children too.
    if (message.parentId && taskRunParentIds.has(message.parentId)) return false;
    if (message.state === "pending" || message.state === "running") return false;
    return message.role === "user" || message.role === "agent" || type === "summary";
  }

  // Maximum UTF-8 bytes the transcript context may occupy before being
  // trimmed. The full prompt (context + task) must fit inside the
  // container's ARG_MAX (2 097 152 bytes on Linux). We reserve ~500 KB for
  // the task text, wrapper headers, and other env vars, leaving 1.5 MB for
  // the context. Oldest entries are dropped first so the most recent
  // messages are always preserved.
  const MAX_CONTEXT_BYTES = 1_500_000;

  async function buildChatTranscriptContext(
    currentMessage: Message,
    currentUserMessageId?: string,
  ): Promise<string> {
    const items = await queries.messages.listAgentContextByChat(pool, currentMessage.chatId);
    const taskRunParentIds = new Set(items.filter((message) => message.kind === "task_run").map((message) => message.id));
    const entries = items
      .filter((message) => message.id !== currentMessage.id && message.id !== currentUserMessageId)
      .filter((message) => shouldIncludeInPromptContext(message, taskRunParentIds))
      .map(formatMessageForPrompt)
      .filter((entry): entry is { role: string; text: string } => entry !== null);

    // Trim from oldest → newest until the serialised context fits.
    const sep = "\n\n---\n\n";
    let bytes = 0;
    let trimFrom = 0; // first index to keep
    for (let i = entries.length - 1; i >= 0; i--) {
      const chunk = `${entries[i].role}:\n${entries[i].text}`;
      bytes += Buffer.byteLength(chunk, "utf8") + (i < entries.length - 1 ? Buffer.byteLength(sep, "utf8") : 0);
      if (bytes > MAX_CONTEXT_BYTES) {
        trimFrom = i + 1;
        break;
      }
    }
    const kept = trimFrom > 0 ? entries.slice(trimFrom) : entries;
    const parts = kept.map((entry) => `${entry.role}:\n${entry.text}`);
    if (trimFrom > 0) {
      parts.unshift(`System:\n[Earlier context omitted — transcript exceeded size limit. ${trimFrom} older message(s) not shown.]`);
    }
    return parts.join(sep);
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
    const providerKeys = userId ? await resolveProviderKeys(userId, workspaceId) : {};
    const extraEnv = userId ? await resolveLocalSourceEnv(pool, userId) : {};
    return await runWorkspaceReflection({
      pool,
      home,
      date: yesterdayDateLocal(),
      workspaceId,
      workspaceSlug,
      workspaceName,
      userId: userId ?? "",
      userName,
      userTimezone,
      agent: { id: agent.id, name: agent.name, model: agent.model },
      providerKeys,
      extraEnv,
      reflectWorkspace: opts.reflectWorkspace ?? productionReflectWorkspace,
      reflectOnEmptyActivity: manual,
    });
  }

  // Convert the reflection journal into a brief task-run log entry. The prompt
  // (`reflection-workspace.md`) is the source of truth for output shape — it
  // asks the model for at most 3 plain bullets. We strip headings/leading
  // bullet markers, drop blanks, and keep the first few lines verbatim so a
  // bad model run is visible (and fixable in the prompt) instead of silently
  // sanitised here.
  function reflectionOutcomeText(journal: string | null): string {
    if (journal === null) return "- No activity.";
    if (journal.trim().length === 0) return "- Empty reflection.";

    const bullets: string[] = [];
    for (const rawLine of journal.split(/\r?\n/)) {
      const line = rawLine
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*]\s+/, "")
        .trim();
      if (!line) continue;
      bullets.push(`- ${line}`);
      if (bullets.length >= 3) break;
    }
    return bullets.length > 0 ? bullets.join("\n") : "- Empty reflection.";
  }

  async function logReflectionOutcome(runId: string, journal: string | null, onLog: (evt: LogEvent) => void | Promise<void>): Promise<void> {
    const text = reflectionOutcomeText(journal);
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
   *     agent against it. The scheduler does not mutate the parent through
   *     pending → running; each fire produces
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
    const { rows: fireChatRows } = await pool.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM chats WHERE id = ?`,
      [msg.chatId],
    );
    const eventWorkspaceId = fireChatRows[0]?.workspace_id;

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
      emit({ type: "message.appended", payload: run, workspaceId: eventWorkspaceId });
      // The task_run child is the authoritative agent-owned Active signal. The
      // parent is emitted only when a lifecycle policy below changes it.
    } else {
      const claimed = await queries.messages.claimPending(pool, messageId);
      if (!claimed) return { fired: false, childIds: [] };
      runId = messageId;
      emit({
        type: "message.updated",
        payload: (await queries.messages.findById(pool, messageId))!,
      });
    }

    // All post-claim work is wrapped in a single try/catch so any failure
    // — including pre-execution setup like prompt building or workspace lookup
    // — always reaches finalizeExecution and never leaves the message stuck
    // in `running` state.
    let logStream: fs.WriteStream | undefined;
    let logFile: string | undefined;

    const onLog = async (evt: LogEvent) => {
      if (!logStream) return;
      // Split on internal newlines so each log file line is exactly one
      // `kind\tpayload\n` record. A single onLog call may carry several
      // events concatenated by the driver (a stdout chunk covering
      // multiple lines); without splitting, the \n framing breaks and
      // readLogEntries can't associate continuation lines with a kind.
      const lines = evt.payload.split("\n");
      for (const line of lines) {
        if (!line) continue;
        logStream.write(`${evt.kind}\t${line}\n`);
        emit({
          type: "message.log_appended",
          payload: { messageId: runId, kind: evt.kind, line },
        });
      }
    };

    try {
      const { prompt, attachments } = await derivePromptInputs(msg);
      const outputKind = outputContentTypeFor(msg);

      // Single JOIN resolves workspace slug, agent, user, timezone, and the
      // chat's persistent goal in one round-trip. `chat_goal` feeds the
      // per-chat goal fragment into the rendered system prompt.
      const { rows: ctxRows } = await pool.query<{
        workspace_id: string;
        workspace_path: string;
        workspace_name: string;
        workspace_kind: string | null;
        agent_id: string | null;
        user_id: string | null;
        username: string | null;
        timezone: string | null;
        chat_goal: string | null;
      }>(
        `SELECT w.id AS workspace_id, w.path AS workspace_path, w.name AS workspace_name,
                w.kind AS workspace_kind, c.agent_id,
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
      const workspaceKind: "project" | "hub" =
        ctxRow?.workspace_kind === "hub" ? "hub" : "project";
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
      logFile = path.join(logDir, `${runId}.log`);
      logStream = fs.createWriteStream(logFile, { flags: "a" });
      const agentId = msg.agentId ?? chatAgentId ?? (await getDefaultAgentId());
      const providerKeys = userId ? await resolveProviderKeys(userId, workspaceId) : {};
      if (userId && Object.keys(providerKeys).length > 0) {
        await queries.providerKeyAccessLog.logKeyAccess(
          pool, userId, "read", Object.keys(providerKeys), `sandbox_run:${runId}`,
        );
      }
      // Codex/ChatGPT bridge: when the user has opted in and the host has a
      // valid `~/.codex/auth.json`, translate it to OpenCode's auth blob and
      // forward it as OPENCODE_AUTH_CONTENT. Re-read per run so a refresh on
      // the host (interactive `codex` use) propagates without recreating the
      // sandbox.
      const extraEnv = userId ? await resolveLocalSourceEnv(pool, userId) : {};
      const agent = await queries.agents.findById(pool, agentId);
      const agentFileInput: AgentFileInput = {
        agentId,
        agentName: agent?.name ?? "Desk Agent",
        model: agent?.model ?? "opencode/big-pickle",
        userName,
        userTimezone,
        chatId: msg.chatId,
        goal: chatGoal,
        runMode: outputKind === "summary" ? "summary" : (msg.kind === "task" && (msg.executeAt || msg.cron) ? "scheduled-task" : "chat"),
        workspaceKind,
      };

      let result: { exitCode: number };
      if (msg.content.type === "reflection_request") {
        // Reflections run in their own short-lived sandbox and never
        // surface a non-zero exit through this path, so they bypass
        // the resource-retry loop entirely.
        const journal = await fireReflectionTask(
          msg,
          workspaceId,
          workspaceSlug,
          workspaceName,
          userId,
          userName,
          userTimezone,
          fireOptions.manual === true,
        );
        await logReflectionOutcome(runId, journal, onLog);
        result = { exitCode: 0 };
      } else {
        // Hub mounts every owned project workspace read-only at
        // `~/workspaces/{slug}/`. Project-workspace runs get the default
        // single-workspace mount plan (no siblings).
        const siblingSlugs = workspaceKind === "hub" && userId
          ? (await queries.workspaces.listByUser(pool, userId))
              .filter((w) => w.id !== workspaceId)
              .map((w) => w.path)
          : [];
        const mountPlan = workspaceKind === "hub"
          ? buildDefaultMountPlan(home, workspaceSlug, siblingSlugs)
          : undefined;

        // Event-driven resource auto-scaling: capture stderr per-attempt
        // and, if a non-zero exit looks resource-shaped (`spawn EAGAIN`,
        // OOM-killer, ENOMEM), grow the sandbox in place and re-run the
        // same message. The user sees a delay, not an error.
        //
        // MAX_RESOURCE_RETRIES caps both retry-loop runaway (a
        // misclassified non-resource failure) and the reachable
        // ceiling. From the 512 baseline, 3 retries hit 1024 → 2048
        // → 4096, matching SANDBOX_MAX_PIDS / SANDBOX_MAX_MEMORY_BYTES.
        const MAX_RESOURCE_RETRIES = 3;
        // Keep only the tail of stderr — a long build can emit MBs of
        // output, and we run `toLowerCase()` plus several regex/includes
        // against this buffer every time we classify. Resource-failure
        // markers all appear near the end of stderr, right before the
        // process exits.
        const STDERR_TAIL_BYTES = 8 * 1024;
        let stderrCapture = "";
        const captureStderr = (payload: string): void => {
          stderrCapture += payload + "\n";
          if (stderrCapture.length > STDERR_TAIL_BYTES) {
            stderrCapture = stderrCapture.slice(-STDERR_TAIL_BYTES);
          }
        };
        const onLogWithStderrCapture = async (evt: LogEvent) => {
          if (evt.kind === "stderr") captureStderr(evt.payload);
          await onLog(evt);
        };
        let attempt = 0;
        while (true) {
          if (opts.execRunFn) {
            result = await opts.execRunFn(runId, agentId, prompt, onLogWithStderrCapture, { agentFileInput, attachments });
          } else {
            const handle = process.env.DESK_SANDBOX_DRIVER === "fake"
              ? { containerId: "fake-sandbox", workspaceId }
              : await createOrReuse(
                  workspaceId,
                  workspaceSlug,
                  home,
                  providerKeys,
                  mountPlan,
                  extraEnv,
                  workspaceKind,
                );
            result = await runtimeExecRun(pool, handle, {
              runId,
              prompt,
              home,
              workspaceId,
              workspaceSlug,
              workspaceKind,
              chatId: msg.chatId,
              agent: agentFileInput,
              attachments,
              providerKeys,
              extraEnv,
              onLog: onLogWithStderrCapture,
            });
          }
          if (result.exitCode === 0) break;
          if (attempt >= MAX_RESOURCE_RETRIES) break;
          const failure = classifyResourceError(result.exitCode, stderrCapture);
          if (!failure) break;
          // Stop the current logStream and truncate the file so the retry
          // log doesn't tail-mix with the failed attempt's events. The user
          // shouldn't see "agent crashed then succeeded"; they should see
          // only the successful attempt's events.
          await new Promise<void>((resolve) => {
            logStream!.once("close", resolve);
            logStream!.end();
          });
          await fs.promises.truncate(logFile!, 0);
          logStream = fs.createWriteStream(logFile!, { flags: "a" });
          stderrCapture = "";
          const growth = await growSandboxForResourceError(workspaceId, failure);
          if (!growth.grew) {
            // Already at the maximum — no point retrying. Fall through to
            // finalise as failed; the user does see the failure in this case.
            console.warn(
              `runId=${runId}: ${failure} pressure but sandbox already at maximum; surfacing failure`,
            );
            break;
          }
          attempt++;
          console.info(
            `runId=${runId}: ${failure} resource failure on attempt ${attempt - 1}, ` +
              `grew sandbox (pids=${growth.pidsLimit}, memory=${growth.memoryBytes}); retrying`,
          );
        }
      }

      // Wait for pending writes to flush before reading the file back.
      await new Promise<void>((resolve) => {
        logStream!.once("finish", resolve);
        logStream!.end();
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
              await snapshotSummary(home, workspaceSlug, msg.chatId, prevRow.id, parsed.body).catch(() => { /* best-effort */ });
            }
          }
        }

        // Summary runs carry kind="summary" on the output child so the
        // insert path treats them as internal (no unread flip).
        const childKind = outputKind === "summary" ? "summary" : undefined;
        const child = await queries.messages.insert(pool, {
          id: generateId("message"),
          chatId: msg.chatId,
          role: "agent",
          content,
          parentId: runId,
          agentId,
          model: agentFileInput.model,
          ...(childKind ? { kind: childKind } : {}),
        });
        // Summary output: also write the body to the notes/ dir so the
        // agent (and any other filesystem consumer) can see the latest
        // summary alongside its own files. Best-effort — the DB row is the
        // source of truth.
        if (content.type === "summary") {
          const { materializeSummary } = await import("@agent-desk/storage");
          await materializeSummary(home, workspaceSlug, msg.chatId, child.id, content.body).catch(() => { /* best-effort */ });
        }
        emit({ type: "message.appended", payload: child, workspaceId });
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
      if (logStream) {
        await new Promise<void>((resolve) => {
          logStream!.once("finish", resolve);
          logStream!.end();
        });
      }
      await queries.messages.finalizeExecution(pool, runId, "failed");
      const failedMsg = await queries.messages.findById(pool, runId);
      if (failedMsg) emit({ type: "message.updated", payload: failedMsg });
      await afterTaskRun(msg, "failed", fireOptions);
      if (!logFile) return { fired: true, childIds: [] };
      const entries = await readLogEntries(logFile);
      const content = buildOutputContent("text", entries);
      if (!content) {
        return { fired: true, childIds: [] };
      }
      // Failed summary runs: tag the error output child with
      // kind="summary" so it doesn't flip unread.
      const errorChildKind = outputContentTypeFor(msg) === "summary" ? "summary" : undefined;
      const child = await queries.messages.insert(pool, {
        id: generateId("message"),
        chatId: msg.chatId,
        role: "agent",
        content,
        parentId: runId,
        ...(errorChildKind ? { kind: errorChildKind } : {}),
      });
      emit({ type: "message.appended", payload: child, workspaceId: eventWorkspaceId });
      return { fired: true, childIds: [child.id] };
    }
  }

  /**
   * After a task run completes: cron tasks advance execute_at to the next
   * occurrence and stay pending; successful one-shot tasks transition to done
   * and clear execute_at. Failed one-shot runs clear the missed occurrence but
   * keep the parent task pending so an error does not count as completion.
   */
  function isUnscheduledTask(task: Message): boolean {
    // Unscheduled tasks are kanban cards first and execution prompts second.
    // A completed agent run is history on a task_run child; it must not
    // silently move the parent card out of Todo/Active regardless of who
    // authored the parent task.
    return task.kind === "task" && !task.executeAt && !task.cron;
  }

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
    if (isUnscheduledTask(task)) return;
    const updated = await queries.messages.updateMessage(pool, task.id, {
      state: terminal === "failed" ? "pending" : terminal,
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

  /**
   * Removes sandbox containers for workspaces that have had no
   * `state='running'` rows and no message activity in the last
   * `idleMs`. Next fire for that workspace builds a fresh container
   * at the baseline 512 / 512 MB — so this also serves as the
   * "scale back to baseline" mechanism, free of charge.
   *
   * One SQL query, one `docker ps`, then one `docker rm -f` per
   * idle workspace. Cheap enough to live alongside the existing
   * 60 s `pollTimer` without measurable cost.
   */
  /**
   * Returns the set of workspace ids that should keep their sandbox
   * alive: any workspace with a `state='running'` row, or any message
   * whose `updated_at` is within `idleMs` of now. Exposed separately
   * from `sweepIdleSandboxes` so tests can pin down the SQL-side
   * decision directly without needing a real container engine.
   */
  async function getActiveWorkspaceIds(idleMs: number): Promise<Set<string>> {
    const cutoff = new Date(Date.now() - idleMs).toISOString();
    // Workspaces with *any* recent activity — running rows, just-fired
    // pending rows, or just-edited rows — count as active and keep their
    // sandbox. Joining through chats so we get workspace_id directly.
    const { rows } = await pool.query<{ workspace_id: string }>(
      `SELECT DISTINCT c.workspace_id
       FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE m.state = 'running'
          OR m.updated_at >= ?`,
      [cutoff],
    );
    return new Set(rows.map((r) => r.workspace_id));
  }

  async function sweepIdleSandboxes(
    idleMs: number = parseInt(process.env.DESK_SANDBOX_IDLE_MS ?? `${30 * 60 * 1000}`, 10),
  ): Promise<string[]> {
    const active = await getActiveWorkspaceIds(idleMs);
    // Pass `idleMs` as the per-container minimum age so a brand-new
    // container created in the window between the SQL query and the
    // `docker ps` can't be reaped — the very next sweep will see its
    // first message row and treat the workspace as active.
    return reapIdleSandboxes(active, idleMs);
  }

  function startIdleSweeper(intervalMs: number = 60_000): NodeJS.Timeout {
    const timer = setInterval(() => {
      void sweepIdleSandboxes().catch((err) => {
        console.warn("idle sandbox sweep failed:", err);
      });
    }, intervalMs);
    timer.unref();
    return timer;
  }
  // Note: an earlier draft of this file shipped a stale-run watchdog that
  // cancelled any `state='running'` row whose `started_at` was older than
  // 30 minutes. That was the wrong shape of fix — a single task should be
  // free to run for 24-48 hours, and silently killing valid long jobs
  // masks the actual root cause of any stuck rows we may see. If we end
  // up with stuck rows in practice, fix the path that left them stuck
  // instead of adding a watchdog that reaps them.

  /** Permanently deletes a message row. Used for ephemeral rows (e.g. summary) that should leave no trace. */
  async function cancelMessage(messageId: string): Promise<void> {
    await pool.query("DELETE FROM messages WHERE id = ?", [messageId]);
  }

  /**
   * Hybrid summary trigger (memory-system spec, P2.2).
   *
   * Counts tokens in the transcript-since-last-summary; if the transcript
   * crosses an adaptive model-aware budget, fire the summary immediately
   * (executeAt = now). Otherwise the existing time-based 30-minute fallback
   * applies.
   *
   * The trigger uses the active chat agent's OpenCode-reported context window
   * when available. Defaults follow long-context RAG/memory practice: summarize
   * at a small fraction of the model window, but clamp the threshold so small
   * local models keep enough working context and frontier models do not wait
   * until chats become unwieldy. Env overrides remain available for ops.
   */
  async function scheduleSummary(chatId: string): Promise<void> {
    await cancelSummaryForChat(chatId);
    const urgent = await isSummaryBudgetExceeded(chatId);
    const summaryContext = await summaryRequestDisplayContext(chatId);
    const executeAt = urgent
      ? new Date().toISOString()
      : new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const messageId = generateId("message");
    await queries.messages.insert(pool, {
      id: messageId,
      chatId,
      role: "system",
      content: {
        type: "summary_request",
        ...(summaryContext.chatTitle ? { chatTitle: summaryContext.chatTitle } : {}),
        ...(summaryContext.messagePreview ? { messagePreview: summaryContext.messagePreview } : {}),
      },
      state: "pending",
      kind: "summary",
      title: summaryContext.title,
      executeAt,
    });
  }

  async function summaryRequestDisplayContext(chatId: string): Promise<{
    chatTitle?: string;
    messagePreview?: string;
    title: string;
  }> {
    const chat = await queries.chats.findById(pool, chatId);
    const chatTitle = chat?.title?.trim() || undefined;
    const messagePreview = await latestUserMessagePreview(chatId);
    const titleParts = [chatTitle, messagePreview].filter((part): part is string => !!part);
    return {
      chatTitle,
      messagePreview,
      title: titleParts.length > 0 ? `Summarize - ${titleParts.join(": ")}` : "Summarize chat",
    };
  }

  async function latestUserMessagePreview(chatId: string): Promise<string | undefined> {
    const { rows } = await pool.query(
      `SELECT content FROM messages
       WHERE chat_id = ?
         AND role = 'user'
         AND json_extract(content, '$.type') = 'text'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [chatId],
    );
    if (rows.length === 0) return undefined;
    const raw = rows[0].content;
    const content = typeof raw === "string" ? JSON.parse(raw) as { text?: unknown } : raw as { text?: unknown };
    if (typeof content.text !== "string") return undefined;
    return summarizeMessagePreview(content.text);
  }

  function summarizeMessagePreview(text: string): string | undefined {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    return normalized.length > 96 ? `${normalized.slice(0, 95).trimEnd()}…` : normalized;
  }

  function envPositiveInt(name: string): number | null {
    const fromEnv = Number.parseInt(
      process.env[name] ?? "",
      10,
    );
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : null;
  }

  function summaryTriggerFraction(): number {
    const fromEnv = Number.parseFloat(process.env.DESK_SUMMARY_TRIGGER_FRACTION ?? "");
    return Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 1 ? fromEnv : 0.15;
  }

  function summaryTriggerBudget(limits: SummaryModelTokenLimits): number {
    const explicit = envPositiveInt("DESK_SUMMARY_TRIGGER_TOKENS");
    if (explicit !== null) return explicit;

    const min = envPositiveInt("DESK_SUMMARY_TRIGGER_MIN_TOKENS") ?? 6_000;
    const max = envPositiveInt("DESK_SUMMARY_TRIGGER_MAX_TOKENS") ?? 12_000;
    const effectiveInputWindow = limits.inputLimit ?? limits.contextWindow;
    const fractional = Math.floor(effectiveInputWindow * summaryTriggerFraction());
    const safeUpperBound = Math.floor(effectiveInputWindow * 0.6);
    return Math.max(1, Math.min(Math.max(fractional, min), max, safeUpperBound));
  }

  async function chatAgentModel(chatId: string): Promise<string> {
    const { rows } = await pool.query(
      `SELECT c.agent_id AS chat_agent_id
       FROM chats c
       WHERE c.id = ?`,
      [chatId],
    );
    const agentId = rows[0]?.chat_agent_id ?? (await getDefaultAgentId());
    const agent = await queries.agents.findById(pool, agentId as string);
    return agent?.model ?? "opencode/big-pickle";
  }

  function normalizeModelLimits(value: number | SummaryModelTokenLimits | null): SummaryModelTokenLimits | null {
    if (typeof value === "number") {
      return Number.isFinite(value) && value > 0 ? { contextWindow: value } : null;
    }
    if (value === null) return null;
    if (!Number.isFinite(value.contextWindow) || value.contextWindow <= 0) return null;
    return {
      contextWindow: value.contextWindow,
      ...(value.inputLimit !== undefined && Number.isFinite(value.inputLimit) && value.inputLimit > 0 ? { inputLimit: value.inputLimit } : {}),
      ...(value.outputLimit !== undefined && Number.isFinite(value.outputLimit) && value.outputLimit > 0 ? { outputLimit: value.outputLimit } : {}),
    };
  }

  function modelLimitsFromRef(model: {
    id: string;
    provider: string;
    contextWindow?: number;
    inputLimit?: number;
    outputLimit?: number;
  }): SummaryModelTokenLimits | null {
    return normalizeModelLimits({
      contextWindow: model.contextWindow ?? model.inputLimit ?? 0,
      ...(model.inputLimit !== undefined ? { inputLimit: model.inputLimit } : {}),
      ...(model.outputLimit !== undefined ? { outputLimit: model.outputLimit } : {}),
    });
  }

  async function summaryModelTokenLimits(chatId: string, modelId: string): Promise<SummaryModelTokenLimits> {
    const fromEnv = envPositiveInt("DESK_SUMMARY_MODEL_CONTEXT_WINDOW");
    if (fromEnv !== null) return { contextWindow: fromEnv };

    if (opts.summaryModelContextWindowFn) {
      const resolved = normalizeModelLimits(await opts.summaryModelContextWindowFn(chatId, modelId).catch(() => null));
      if (resolved !== null) return resolved;
    }

    const { rows } = await pool.query(
      `SELECT w.id AS workspace_id, w.path AS workspace_path, w.user_id AS user_id
       FROM chats c
       JOIN workspaces w ON w.id = c.workspace_id
       WHERE c.id = ?`,
      [chatId],
    );
    const row = rows[0];
    const workspaceId = row?.workspace_id as string | undefined;
    const workspaceSlug = row?.workspace_path as string | undefined;
    if (workspaceId && workspaceSlug) {
      const cacheKey = `${workspaceId}:${row?.user_id ?? ""}`;
      const cached = modelContextCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        const value = cached.values.get(modelId);
        if (value !== undefined) return value;
      }
      try {
        const userId = row?.user_id as string | undefined;
        const providerKeys = userId ? await resolveProviderKeys(userId, workspaceId) : {};
        const extraEnv = userId ? await resolveLocalSourceEnv(pool, userId) : {};
        const models = await listModels(workspaceId, workspaceSlug, {
          providerKeys,
          env: extraEnv,
          timeoutMs: 5_000,
        });
        const values = new Map<string, SummaryModelTokenLimits>();
        for (const model of models) {
          const limits = modelLimitsFromRef(model);
          if (limits !== null) values.set(model.id, limits);
        }
        modelContextCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60 * 1000, values });
        const value = values.get(modelId);
        if (value !== undefined) return value;
      } catch {
        // Model metadata is best-effort. Scheduling must never fail because the
        // sandbox or provider key lookup is temporarily unavailable.
      }
    }

    // Conservative fallback for unknown/local models when OpenCode metadata is
    // unavailable: enough room for a useful transcript, much lower than old 60K.
    return { contextWindow: 60_000 };
  }

  async function isSummaryBudgetExceeded(chatId: string): Promise<boolean> {
    const items = await queries.messages.listAgentContextByChat(pool, chatId);
    const taskRunParentIds = new Set(items.filter((message) => message.kind === "task_run").map((message) => message.id));
    const tokenized = items
      .filter((message) => shouldIncludeInPromptContext(message, taskRunParentIds))
      .map((m) => {
        const formatted = formatMessageForPrompt(m);
        return formatted ? { role: formatted.role, text: formatted.text } : null;
      })
      .filter((m): m is { role: string; text: string } => m !== null);
    const used = estimateMessagesTokens(tokenized);
    const modelId = await chatAgentModel(chatId);
    const limits = await summaryModelTokenLimits(chatId, modelId);
    const budget = summaryTriggerBudget(limits);
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

  /**
   * If the chat's currently-running agent_turn has gone silent (no log
   * activity for `staleAfterMs`), cancel it so a follow-up user message
   * can be fired in its place. An active run — one whose opencode is
   * still emitting events (tokens, tool calls, step boundaries) — is
   * left untouched; a user follow-up sent while a healthy run is in
   * flight will create a new agent_turn but won't interrupt the old one.
   *
   * The signal is *log mtime*, not wall-clock age of the row. Opencode
   * writes to the per-message log file on every event via `onLog`, so a
   * legitimately long-running step (large LLM stream, slow tool, chatty
   * build) keeps the file growing and is never considered stalled. The
   * file only stops growing when opencode is genuinely waiting on
   * something that isn't coming back (deadlocked tool, dropped LLM
   * connection, internal hang).
   *
   * Why this exists: the user noticed chats sitting in `state='running'`
   * for very long stretches with no reply, and our previous behavior had
   * no way to recover without a server restart. With this hook called
   * from the POST /messages route, a follow-up like "Are you stuck?"
   * unblocks the chat by preempting the hung run, while a follow-up to a
   * healthy long task does nothing harmful.
   */
  async function preemptStalledChatRun(
    chatId: string,
    opts: { staleAfterMs?: number } = {},
  ): Promise<{ preempted: string } | null> {
    const staleAfterMs = opts.staleAfterMs
      ?? parseInt(process.env.DESK_RUN_STALE_PREEMPT_MS ?? "30000", 10);
    // Only consider 'chat'-kind agent_turn rows: scheduled task_runs in the
    // same chat have their own lifecycle and shouldn't be interrupted by a
    // chat follow-up.
    const { rows } = await pool.query<{
      id: string;
      workspace_slug: string;
      started_at: string | null;
    }>(
      `SELECT m.id, w.path AS workspace_slug, m.started_at
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
         JOIN workspaces w ON w.id = c.workspace_id
        WHERE m.chat_id = ?
          AND m.state = 'running'
          AND m.kind = 'chat'
          AND json_valid(m.content)
          AND json_extract(m.content, '$.type') = 'agent_turn'
        ORDER BY m.created_at DESC
        LIMIT 1`,
      [chatId],
    );
    if (rows.length === 0) return null;
    const running = rows[0];
    const logPath = path.join(
      home,
      running.workspace_slug,
      ".chats",
      chatId,
      "logs",
      `${running.id}.log`,
    );
    let mtimeMs: number;
    try {
      const stat = await fsp.stat(logPath);
      mtimeMs = stat.mtimeMs;
    } catch {
      // Deliberately conservative: a missing log file means opencode hasn't
      // emitted its first event yet, which usually means the run is still
      // in container-cold-start (entrypoint downloading deps, image pull,
      // `.deskrc` running). Those legitimately take minutes; preempting
      // there would abandon valid in-flight work. We only preempt when we
      // have positive evidence of activity-then-silence — that's the
      // "opencode wedged" signal. Stuck rows with no log ever are recovered
      // by `recoverOrphanedRuns` at the requeue cap, not this hook.
      return null;
    }
    const ageMs = Date.now() - mtimeMs;
    if (ageMs < staleAfterMs) return null;
    await cancelRun(running.id);
    return { preempted: running.id };
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
    sweepIdleSandboxes,
    startIdleSweeper,
    getActiveWorkspaceIds,
    cancelMessage,
    cancelRun,
    preemptStalledChatRun,
    pauseMessage,
    resumeMessage,
    rescheduleMessage,
    cancelScheduledMessage,
    scheduleSummary,
    cancelSummary,
    cancelSummaryForChat,
  };
}
