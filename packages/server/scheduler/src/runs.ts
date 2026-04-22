import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import pg from "pg";
import {
  generateId,
  type Run,
  type WsEvent,
} from "@desk/shared";
import { queries } from "@desk/db";
import {
  createOrReuse,
  execRun as runtimeExecRun,
  cancelRun as runtimeCancelRun,
  createDriver,
  type LogEvent,
  type AgentFileInput,
} from "@desk/runtime";
import { createAdapter, type ScheduleAdapter } from "./scheduleAdapter.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonEvent = Record<string, any>;

export interface EnqueueRunInput {
  chatId?: string;
  prompt: string;
  mode: "immediate" | "scheduled" | "recurring" | "ai_note";
  spec?: string; // at-time for scheduled, cron expr for recurring
}

export interface RunManagerOptions {
  pool: pg.Pool;
  adapter?: ScheduleAdapter;
  emit?: (event: WsEvent) => void;
  /** Called to execute a run. Injected by runtime. */
  execRunFn?: (
    runId: string,
    agentId: string,
    prompt: string,
    onLog: (evt: LogEvent) => void,
    opts?: { agentFileInput: AgentFileInput },
  ) => Promise<{ exitCode: number }>;
}

/**
 * Build the shell command that at/cron will execute for a legacy
 * scheduled_jobs row: curl /internal/runs/fire with the jobId.
 */
function buildScheduleCmd(jobId: string): string {
  return buildFireCmd("/internal/runs/fire", { jobId });
}

/**
 * Build the shell command that at/cron will execute for a message-based
 * scheduled fire: curl /internal/messages/fire with the messageId.
 */
function buildMessageFireCmd(messageId: string): string {
  return buildFireCmd("/internal/messages/fire", { messageId });
}

function buildFireCmd(endpoint: string, body: Record<string, string>): string {
  const tokenPath = process.env.DESK_INTERNAL_TOKEN_PATH ?? "/etc/desk-server/internal-token";
  const port = process.env.DESK_API_PORT ?? process.env.PORT ?? "8080";
  const url = `http://127.0.0.1:${port}${endpoint}`;
  const bodyJson = JSON.stringify(body).replace(/"/g, '\\"');
  return (
    `sh -c 'T=$(cat ${tokenPath}) && ` +
    `curl -sf -X POST ` +
    `-H "Authorization: Bearer $T" ` +
    `-H "Content-Type: application/json" ` +
    `-d "${bodyJson}" ` +
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

  async function enqueueRun(input: EnqueueRunInput): Promise<Run> {
    const runId = generateId("run");

    const run = await queries.runs.insert(pool, {
      id: runId,
      chatId: input.chatId,
      kind: input.mode,
      state: "pending",
    });

    switch (input.mode) {
      case "immediate": {
        // Fire and forget
        executeRun(runId, input.prompt).catch((err) => {
          console.error(`Run ${runId} failed:`, err);
        });
        break;
      }
      case "scheduled": {
        const jobId = generateId("scheduledJob");
        const atTime = input.spec ?? "now + 1 minute";
        const atJobId = await adapter.scheduleAt(buildScheduleCmd(jobId), atTime);
        await queries.scheduledJobs.insert(pool, {
          id: jobId,
          chatId: input.chatId,
          kind: "once",
          spec: { type: "once", onceAt: atTime },
          atJobId,
        });
        // Link run to job
        await pool.query(`UPDATE runs SET scheduled_job_id = $1 WHERE id = $2`, [jobId, runId]);
        break;
      }
      case "recurring": {
        const jobId = generateId("scheduledJob");
        const cronExpr = input.spec ?? "*/5 * * * *";
        await adapter.installCron(jobId, cronExpr, buildScheduleCmd(jobId));
        await queries.scheduledJobs.insert(pool, {
          id: jobId,
          chatId: input.chatId,
          kind: "recurring",
          spec: { type: "recurring", cronExpr },
          crontabId: jobId,
        });
        await pool.query(`UPDATE runs SET scheduled_job_id = $1 WHERE id = $2`, [jobId, runId]);
        break;
      }
      case "ai_note": {
        // Cancel any existing ai_note for this chat first
        if (input.chatId) {
          await cancelAiNoteForChat(input.chatId);
        }

        const jobId = generateId("scheduledJob");
        const delayMs = 30 * 60 * 1000; // 30 minutes
        const atTime = `now + 30 minutes`;
        const atJobId = await adapter.scheduleAt(buildScheduleCmd(jobId), atTime);
        await queries.scheduledJobs.insert(pool, {
          id: jobId,
          chatId: input.chatId,
          kind: "ai_note",
          spec: { type: "ai_note", aiNoteDelayMs: delayMs },
          atJobId,
        });
        await pool.query(`UPDATE runs SET scheduled_job_id = $1 WHERE id = $2`, [jobId, runId]);
        break;
      }
    }

    return run;
  }

  /**
   * Fires a pending scheduled message: atomically claims it
   * (pending → running), runs the agent with the message content as the
   * prompt, and emits the output as a child message. Idempotent —
   * concurrent fires on the same messageId land on the claim check and
   * no-op.
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

    const isAiNoteRequest =
      (msg.content as { type?: string }).type === "ai_note_request";
    const prompt = derivePromptFromContent(msg.content);

    const logDir = await ensureLogDir(msg.chatId);
    const logFile = path.join(logDir, `${messageId}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: "a" });

    const onLog = async (evt: LogEvent) => {
      logStream.write(`${evt.kind}\t${evt.payload}\n`);
      emit({
        type: "message.log_appended",
        payload: { messageId, kind: evt.kind, line: evt.payload },
      });
    };

    try {
      const chat = await queries.chats.findById(pool, msg.chatId);
      const agentId = msg.agentId ?? chat?.agentId ?? (await getDefaultAgentId());
      const workspaceId = chat?.workspaceId ?? (await firstWorkspaceId());
      const userId = await resolveUserIdForWorkspace(workspaceId);
      const userName = userId
        ? (await queries.users.findById(pool, userId))?.username ?? "User"
        : "User";
      const providerKeys = userId
        ? await queries.userSettings.getProviderKeys(pool, userId)
        : {};
      const agent = await queries.agents.findById(pool, agentId);
      const agentFileInput = {
        agentId,
        agentName: agent?.name ?? "Desk Agent",
        model: agent?.model ?? "anthropic/claude-sonnet-4-5",
        instructions: agent?.instructions ?? "",
        userName,
      };

      let result: { exitCode: number };
      if (opts.execRunFn) {
        result = await opts.execRunFn(messageId, agentId, prompt, onLog, { agentFileInput });
      } else if (process.env.DESK_SANDBOX_DRIVER === "fake") {
        const driver = createDriver();
        result = await driver.execRun(workspaceId, {
          runId: messageId,
          prompt,
          agentFileId: agentId,
          onLog,
        });
      } else {
        const home = process.env.DESK_HOME ?? "/opt/desk";
        const handle = await createOrReuse(workspaceId, home, providerKeys);
        result = await runtimeExecRun(pool, handle, {
          runId: messageId,
          prompt,
          home,
          workspaceId,
          chatId: msg.chatId,
          agent: agentFileInput,
          onLog,
        });
      }

      logStream.end();
      const terminal = result.exitCode === 0 ? "succeeded" : "failed";
      await queries.messages.finalizeExecution(pool, messageId, terminal);
      emit({
        type: "message.updated",
        payload: (await queries.messages.findById(pool, messageId))!,
      });

      const body = (await readLogFileBody(logFile)).trim();
      if (body) {
        const child = await queries.messages.insert(pool, {
          id: generateId("message"),
          chatId: msg.chatId,
          role: "agent",
          content: isAiNoteRequest ? { type: "note", body } : { type: "text", text: body },
          parentId: messageId,
          agentId,
        });
        emit({ type: "message.appended", payload: child });
        return { fired: true, childIds: [child.id] };
      }
      return { fired: true, childIds: [] };
    } catch (err) {
      logStream.end();
      console.error(`fireMessage ${messageId} failed:`, err);
      await queries.messages.finalizeExecution(pool, messageId, "failed");
      emit({
        type: "message.updated",
        payload: (await queries.messages.findById(pool, messageId))!,
      });
      return { fired: true, childIds: [] };
    }
  }

  async function firstWorkspaceId(): Promise<string> {
    const { rows } = await pool.query("SELECT id FROM workspaces ORDER BY created_at LIMIT 1");
    return rows[0]?.id as string;
  }

  async function resolveUserIdForWorkspace(workspaceId: string): Promise<string | null> {
    if (!workspaceId) return null;
    const ws = await queries.workspaces.findById(pool, workspaceId);
    return ws?.userId ?? null;
  }

  async function ensureLogDir(chatId: string): Promise<string> {
    const home = process.env.DESK_HOME ?? "/opt/desk";
    const dir = path.join(home, "Desk", "workspaces", "desk", ".chats", chatId, "logs");
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }

  async function readLogFileBody(p: string): Promise<string> {
    try {
      const buf = await fsp.readFile(p, "utf8");
      return buf
        .split("\n")
        .map((line) => {
          const tab = line.indexOf("\t");
          return tab > 0 ? line.slice(tab + 1) : line;
        })
        .join("\n");
    } catch {
      return "";
    }
  }

  function derivePromptFromContent(content: unknown): string {
    const c = content as { type?: string; text?: string; body?: string };
    if (c?.type === "text" && typeof c.text === "string") return c.text;
    if (c?.type === "ai_note_request") {
      return "Produce a coherent running summary of this chat, in markdown.";
    }
    return JSON.stringify(content);
  }

  /**
   * Runs a scheduled job immediately, as if at/cron had fired it.
   * Creates a new run, executes it in-process, returns the run id.
   * This is what /internal/runs/fire invokes.
   */
  async function fireJob(jobId: string): Promise<string> {
    const job = await queries.scheduledJobs.findById(pool, jobId);
    if (!job) throw new Error(`Scheduled job not found: ${jobId}`);
    if (!job.active) {
      // Job was cancelled between at-firing and our lookup. No-op.
      return "";
    }

    const run = await enqueueRun({
      chatId: job.chatId,
      prompt: `Execute scheduled job ${jobId}`,
      mode: "immediate",
    });
    await pool.query(`UPDATE runs SET scheduled_job_id = $1 WHERE id = $2`, [jobId, run.id]);
    return run.id;
  }

  async function executeRun(runId: string, prompt: string): Promise<void> {
    await queries.runs.updateState(pool, runId, { state: "running" });
    emit({ type: "run.state_changed", payload: (await queries.runs.findById(pool, runId))! });

    let seq = 0;
    const onLog = async (evt: LogEvent) => {
      try {
        await queries.runEvents.append(pool, {
          id: generateId("runEvent"),
          runId,
          seq: seq++,
          kind: evt.kind,
          payload: { text: evt.payload },
        });
        emit({
          type: "run.log_appended",
          payload: { runId, seq: evt.seq, kind: evt.kind, payload: evt.payload },
        });
      } catch {
        // Log failure shouldn't crash the run
      }
    };

    try {
      // Resolve agent, workspace, and user via the run's chat chain:
      // run → chat → agent/workspace, workspace → user
      const runRow = await queries.runs.findById(pool, runId);
      let agentId: string;
      let chatId: string | undefined;
      let workspaceId: string | undefined;
      let userId: string | undefined;
      let userName = "User";
      if (runRow?.chatId) {
        chatId = runRow.chatId;
        const chat = await queries.chats.findById(pool, runRow.chatId);
        agentId = chat?.agentId ?? (await getDefaultAgentId());
        workspaceId = chat?.workspaceId;
        if (chat?.workspaceId) {
          const ws = await queries.workspaces.findById(pool, chat.workspaceId);
          if (ws?.userId) {
            userId = ws.userId;
            const user = await queries.users.findById(pool, ws.userId);
            if (user) userName = user.username;
          }
        }
      } else {
        agentId = await getDefaultAgentId();
      }
      if (!workspaceId) {
        const { rows } = await pool.query(
          "SELECT id FROM workspaces ORDER BY created_at LIMIT 1",
        );
        workspaceId = rows[0]?.id as string | undefined;
      }
      if (!userId) {
        const { rows } = await pool.query(
          "SELECT id FROM users ORDER BY created_at LIMIT 1",
        );
        userId = rows[0]?.id as string | undefined;
      }
      const providerKeys = userId
        ? await queries.userSettings.getProviderKeys(pool, userId)
        : {};
      const agent = await queries.agents.findById(pool, agentId);

      const agentFileInput = {
        agentId,
        agentName: agent?.name ?? "Desk Agent",
        model: agent?.model ?? "anthropic/claude-sonnet-4-5",
        instructions: agent?.instructions ?? "",
        userName,
      };

      let result: { exitCode: number };
      const effectiveWorkspaceId = workspaceId ?? "default";
      if (opts.execRunFn) {
        result = await opts.execRunFn(runId, agentId, prompt, onLog, { agentFileInput });
      } else if (process.env.DESK_SANDBOX_DRIVER === "fake") {
        // Use the fake driver directly — no Docker, no token, no mounts
        const driver = createDriver();
        result = await driver.execRun(effectiveWorkspaceId, { runId, prompt, agentFileId: agentId, onLog });
      } else {
        // Use the full opencode lifecycle: write agent file → mint token → project mounts → exec → cleanup
        const home = process.env.DESK_HOME ?? "/opt/desk";
        const handle = await createOrReuse(effectiveWorkspaceId, home, providerKeys);
        result = await runtimeExecRun(pool, handle, {
          runId,
          prompt,
          home,
          workspaceId: effectiveWorkspaceId,
          chatId,
          agent: agentFileInput,
          onLog,
        });
      }

      const newState = result.exitCode === 0 ? "succeeded" : "failed";
      await queries.runs.updateState(pool, runId, {
        state: newState,
        exitCode: result.exitCode,
      });
      emit({ type: "run.state_changed", payload: (await queries.runs.findById(pool, runId))! });

      // Persist assistant message from the run's event stream.
      // OpenCode emits JSON-stream lines when invoked with --format json.
      // Docker may split a single JSON event across multiple stdout chunks,
      // so we concatenate all stdout, then parse with partial-line
      // accumulation to reassemble split events before JSON.parse.
      const run = await queries.runs.findById(pool, runId);
      if (run?.chatId) {
        const logEvents = await queries.runEvents.listByRun(pool, runId, { limit: 10000 });

        // Separate stdout (JSON events) from stderr (plain text like migration logs)
        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];
        for (const e of logEvents.items) {
          const p = e.payload as Record<string, unknown>;
          const raw = typeof p.text === "string" ? p.text : "";
          if (!raw) continue;
          if (e.kind === "stderr") stderrChunks.push(raw);
          else stdoutChunks.push(raw);
        }

        // Join chunks with newlines (Docker strips trailing newlines from
        // chunks, causing adjacent events to merge). Parse each line as
        // JSON, accumulating partial lines for split events.
        const fullStdout = stdoutChunks.join("\n");
        const parsedEvents: JsonEvent[] = [];
        let anyJson = false;
        let partial = "";
        const plainLines: string[] = [];
        for (const line of fullStdout.split(/\r?\n/)) {
          const l = line.trim();
          if (!l) continue;
          const candidate = partial ? partial + l : l;
          try {
            const obj = JSON.parse(candidate);
            anyJson = true;
            partial = "";
            parsedEvents.push(obj);
          } catch {
            if (candidate.startsWith("{")) {
              partial = candidate;
            } else {
              partial = "";
              if (!anyJson) plainLines.push(l);
            }
          }
        }

        // Prepend stderr as a synthetic text event
        if (stderrChunks.length > 0) {
          parsedEvents.unshift({
            type: "text",
            part: { text: stderrChunks.join("\n") },
          });
        }

        // ai_note runs produce a single `note`-content message (a coherent
        // summary). Regular runs produce an `events` or `text` message.
        const isAiNote = run.kind === "ai_note";

        if (isAiNote) {
          // For ai_note, synthesize a plain-text body from either the
          // parsed events' last text part, the fake driver's plain lines,
          // or the raw stdout. The agent is expected to emit markdown.
          let body = "";
          if (parsedEvents.length > 0) {
            const lastText = parsedEvents
              .map((e) => {
                const part = e.part as { text?: string } | undefined;
                return typeof part?.text === "string" ? part.text : "";
              })
              .filter((t) => t.length > 0)
              .join("\n\n");
            body = lastText;
          }
          if (!body) {
            const allPlain = [...stderrChunks, ...plainLines];
            body = allPlain.join("\n").trim() || fullStdout.trim();
          }
          if (body) {
            const noteMsg = await queries.messages.insert(pool, {
              id: generateId("message"),
              chatId: run.chatId,
              role: "agent",
              content: { type: "note", body },
            });
            emit({ type: "message.appended", payload: noteMsg });
          }
        } else if (parsedEvents.length > 0) {
          // Store the full event array
          const assistantMsg = await queries.messages.insert(pool, {
            id: generateId("message"),
            chatId: run.chatId,
            role: "agent",
            content: { type: "events", events: parsedEvents },
          });
          emit({ type: "message.appended", payload: assistantMsg });
        } else {
          // Non-JSON run (e.g. fake driver) — store as plain text
          const allPlain = [...stderrChunks, ...plainLines];
          const text = allPlain.join("\n").trim() || fullStdout.trim();
          if (text) {
            const assistantMsg = await queries.messages.insert(pool, {
              id: generateId("message"),
              chatId: run.chatId,
              role: "agent",
              content: { type: "text", text },
            });
            emit({ type: "message.appended", payload: assistantMsg });
          }
        }
      }
    } catch (err) {
      console.error(`Run ${runId} failed:`, err);
      await queries.runs.updateState(pool, runId, { state: "failed", exitCode: 1 });
      emit({ type: "run.state_changed", payload: (await queries.runs.findById(pool, runId))! });
    }
  }

  async function cancelRun(runId: string): Promise<void> {
    const run = await queries.runs.findById(pool, runId);
    if (!run) return;

    if (run.state === "running") {
      await runtimeCancelRun(runId);
    }
    await queries.runs.updateState(pool, runId, { state: "cancelled" });
    emit({ type: "run.state_changed", payload: (await queries.runs.findById(pool, runId))! });
  }

  async function cancelJob(jobId: string): Promise<void> {
    const job = await queries.scheduledJobs.findById(pool, jobId);
    if (!job || !job.active) return;

    if (job.atJobId) {
      try { await adapter.removeAt(job.atJobId); } catch { /* ok */ }
    }
    if (job.crontabId) {
      try { await adapter.removeCron(job.crontabId); } catch { /* ok */ }
    }

    await queries.scheduledJobs.cancel(pool, jobId);
  }

  async function cancelAiNoteForChat(chatId: string): Promise<void> {
    // Legacy path — cancel scheduled_jobs rows of kind ai_note. Kept for
    // backward-compat with anything still hitting enqueueRun({mode:ai_note}).
    const activeJobs = await queries.scheduledJobs.listActive(pool);
    for (const job of activeJobs) {
      if (job.chatId === chatId && job.kind === "ai_note") {
        await cancelJob(job.id);
      }
    }

    // New path — cancel pending ai_note_request messages.
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

  /**
   * Schedules a new ai-note refresh for the chat. Under the messages-as-
   * truth model this creates a pending `ai_note_request`-content message
   * with execute_at = now+30min and a scheduler_ref pointing at the
   * installed at-job. At fire time the at command curls
   * /internal/messages/fire, which routes through fireMessage() and
   * produces a `note`-content child message.
   *
   * Any existing pending ai_note_request for the chat is cancelled first
   * (at-job removed + row deleted), matching the "one running note per
   * chat" invariant.
   */
  async function scheduleAiNote(chatId: string): Promise<void> {
    await cancelAiNoteForChat(chatId);

    const messageId = generateId("message");
    const atTime = `now + 30 minutes`;
    const cmd = buildMessageFireCmd(messageId);
    const atJobId = await adapter.scheduleAt(cmd, atTime);

    // Insert the pending ai_note_request message carrying the at ref.
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

  async function cancelAiNote(chatId: string): Promise<void> {
    await cancelAiNoteForChat(chatId);
  }

  return {
    enqueueRun,
    executeRun,
    fireJob,
    fireMessage,
    cancelRun,
    cancelJob,
    cancelAiNoteForChat,
    scheduleAiNote,
    cancelAiNote,
    adapter,
  };
}
