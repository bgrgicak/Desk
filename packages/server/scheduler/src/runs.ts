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
} from "@desk/runtime";
import { createAdapter, type ScheduleAdapter } from "./scheduleAdapter.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonEvent = Record<string, any>;

/**
 * Extract all top-level JSON objects from a string. Uses a brace-balanced
 * scanner that tracks JSON string quoting. Handles invalid JSON where
 * literal newlines appear inside string values (common when output fields
 * contain multi-line text that wasn't properly escaped).
 */
function extractJsonObjects(raw: string): JsonEvent[] {
  // Fast path: try fixing bare newlines and parsing as a single object
  const fixed = raw.replace(/[\n\r]/g, "\\n");
  if (fixed.trimStart().startsWith("{") && fixed.trimEnd().endsWith("}")) {
    try {
      const obj = JSON.parse(fixed);
      if (obj && typeof obj === "object") return [obj];
    } catch { /* fall through to scanner */ }
  }

  const results: JsonEvent[] = [];
  let depth = 0, start = -1, inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === '"' || ch === "\n" || ch === "\r") inStr = false;
      continue;
    }
    if (ch === '"' && depth > 0) { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = raw.slice(start, i + 1);
        try { results.push(JSON.parse(candidate)); } catch {
          try { results.push(JSON.parse(candidate.replace(/[\n\r]/g, "\\n"))); } catch { /* skip */ }
        }
        start = -1;
      }
    }
  }
  return results;
}

/**
 * Extract user-facing text from a single OpenCode JSON event.
 * Returns the text content or null if the event has no displayable text.
 */
function textFromEvent(ev: JsonEvent): string | null {
  if (ev.type === "text" && typeof ev.part?.text === "string") {
    return ev.part.text;
  }
  // tool_use events carry output in part.state.output (agent task results)
  if (ev.type === "tool_use" && typeof ev.part?.state?.output === "string") {
    return ev.part.state.output;
  }
  return null;
}

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
    opts?: { systemPrompt?: string },
  ) => Promise<{ exitCode: number }>;
}

/** Build the shell command that at/cron will execute for a scheduled job. */
function buildScheduleCmd(jobId: string): string {
  const envVars: string[] = [];
  if (process.env.DATABASE_URL) envVars.push(`DATABASE_URL=${process.env.DATABASE_URL}`);
  if (process.env.DESK_SANDBOX_DRIVER) envVars.push(`DESK_SANDBOX_DRIVER=${process.env.DESK_SANDBOX_DRIVER}`);
  const bin = process.env.DESK_RUN_BIN ?? "desk-run";
  return [...envVars, bin, jobId].join(" ");
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
      // Resolve agent via the run's chat, falling back to default
      const runRow = await queries.runs.findById(pool, runId);
      let agentId: string;
      if (runRow?.chatId) {
        const chat = await queries.chats.findById(pool, runRow.chatId);
        agentId = chat?.agentId ?? (await getDefaultAgentId());
      } else {
        agentId = await getDefaultAgentId();
      }
      const agent = await queries.agents.findById(pool, agentId);
      const systemPrompt = agent?.instructions || undefined;

      let result: { exitCode: number };
      if (opts.execRunFn) {
        result = await opts.execRunFn(runId, agentId, prompt, onLog, { systemPrompt });
      } else if (process.env.DESK_SANDBOX_DRIVER === "fake") {
        // Use the fake driver directly — no Docker, no token, no mounts
        const driver = createDriver();
        result = await driver.execRun(agentId, { runId, prompt, systemPrompt, onLog });
      } else {
        // Use the full opencode lifecycle: mint token → project mounts → exec → cleanup
        const home = process.env.DESK_HOME ?? "/opt/desk";
        const handle = await createOrReuse(agentId, home);
        result = await runtimeExecRun(pool, handle, {
          runId,
          prompt,
          systemPrompt,
          home,
          workspaceId: "default",
          chatId: runRow?.chatId ?? undefined,
          onLog,
        });
      }

      const newState = result.exitCode === 0 ? "succeeded" : "failed";
      await queries.runs.updateState(pool, runId, {
        state: newState,
        exitCode: result.exitCode,
      });
      emit({ type: "run.state_changed", payload: (await queries.runs.findById(pool, runId))! });

      // Persist assistant message from concatenated run_events text.
      // OpenCode emits JSON-stream lines when invoked with --format json; each
      // line is one event. Extract only the "text" events' .part.text for the
      // user-facing message. Fall back to the raw payload if parsing fails
      // (e.g. the fake driver emits plain text lines).
      const run = await queries.runs.findById(pool, runId);
      if (run?.chatId) {
        const events = await queries.runEvents.listByRun(pool, runId, { limit: 10000 });
        const parts: string[] = [];
        for (const e of events.items) {
          const p = e.payload as Record<string, unknown>;
          const raw = typeof p.text === "string" ? p.text : "";
          if (!raw) continue;
          // Each raw chunk may contain several newline-delimited JSON events.
          // Docker demux can also deliver multiple JSON objects in a single
          // chunk without newlines, so we extract all top-level {...} objects.
          let pushedFromJson = false;
          for (const obj of extractJsonObjects(raw)) {
            pushedFromJson = true;
            const extracted = textFromEvent(obj);
            if (extracted) parts.push(extracted);
            // Non-text events (step_start, step_finish, etc.) —
            // skip silently.
          }
          if (!pushedFromJson) parts.push(raw);
        }
        const text = parts.join("\n").trim();
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
    } catch (err) {
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
    const activeJobs = await queries.scheduledJobs.listActive(pool);
    for (const job of activeJobs) {
      if (job.chatId === chatId && job.kind === "ai_note") {
        await cancelJob(job.id);
      }
    }
  }

  async function scheduleAiNote(chatId: string): Promise<void> {
    await enqueueRun({
      chatId,
      prompt: "Generate an AI note summarizing this chat conversation.",
      mode: "ai_note",
    });
  }

  async function cancelAiNote(chatId: string): Promise<void> {
    await cancelAiNoteForChat(chatId);
  }

  return {
    enqueueRun,
    executeRun,
    cancelRun,
    cancelJob,
    cancelAiNoteForChat,
    scheduleAiNote,
    cancelAiNote,
    adapter,
  };
}
