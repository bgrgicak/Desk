import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@agent-desk/db";
import { runMigrations, seedIfEmpty, queries } from "@agent-desk/db";
import { generateId, type WsEvent } from "@agent-desk/shared";
import { createRunManager } from "../src/runs.js";
import type { LogEvent } from "@agent-desk/runtime";

let pool: Pool;
let agentId: string;
let chatId: string;
let dbPath: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-scheduler-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "testuser";
  process.env.DESK_SEED_PASSWORD = "testpass";
  await seedIfEmpty(pool);

  const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
  agentId = agentRows[0].id as string;
  const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
  const workspaceId = wsRows[0].id as string;

  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id)
     VALUES (?, ?) ON CONFLICT DO NOTHING`,
    [workspaceId, agentId],
  );

  chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
    [chatId, workspaceId, agentId, "Test Chat"],
  );

  // Log files land under $DESK_HOME/Desk/workspaces/desk/.chats/{chatId}/logs/
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "desk-scheduler-"));
  process.env.DESK_HOME = tmpHome;
});

afterAll(async () => {
  if (pool) await pool.end();
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
});

async function insertPendingMessage(content: unknown): Promise<string> {
  const id = generateId("message");
  await pool.query(
    `INSERT INTO messages (id, chat_id, role, content, state)
     VALUES (?, ?, 'system', ?, 'pending')`,
    [id, chatId, JSON.stringify(content)],
  );
  return id;
}

async function insertTask(opts: { content: unknown; cron?: string; executeAt?: string; role?: string }): Promise<string> {
  const id = generateId("message");
  await pool.query(
    `INSERT INTO messages (id, chat_id, role, content, state, kind, cron, execute_at)
     VALUES (?, ?, ?, ?, 'pending', 'task', ?, ?)`,
    [
      id,
      chatId,
      opts.role ?? "user",
      JSON.stringify(opts.content),
      opts.cron ?? null,
      opts.executeAt ? new Date(opts.executeAt) : null,
    ],
  );
  return id;
}

async function listTaskRuns(taskId: string): Promise<Array<{ id: string; state: string; startedAt: Date | null; endedAt: Date | null }>> {
  const { rows } = await pool.query(
    `SELECT id, state, started_at, ended_at FROM messages
     WHERE parent_id = ? AND kind = 'task_run'
     ORDER BY started_at IS NULL, started_at ASC, id ASC`,
    [taskId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    state: r.state as string,
    startedAt: r.started_at as Date | null,
    endedAt: r.ended_at as Date | null,
  }));
}

describe("fireMessage", () => {
  it("claims pending → running, runs the agent, produces an events child, succeeds", async () => {
    const events: WsEvent[] = [];
    const fakeExec = async (
      messageId: string,
      _agentId: string,
      _prompt: string,
      onLog: (evt: LogEvent) => void,
    ) => {
      onLog({ runId: messageId, seq: 0, kind: "stdout", payload: JSON.stringify({ type: "step_start", sessionID: "s1" }) });
      onLog({ runId: messageId, seq: 1, kind: "stdout", payload: JSON.stringify({ type: "text", part: { text: "hello from agent" } }) });
      onLog({ runId: messageId, seq: 2, kind: "stderr", payload: "diagnostic noise" });
      onLog({ runId: messageId, seq: 3, kind: "stdout", payload: JSON.stringify({ type: "step_finish" }) });
      return { exitCode: 0 };
    };

    const mgr = createRunManager({
      pool,
emit: (evt) => events.push(evt),
      execRunFn: fakeExec,
    });

    const messageId = await insertPendingMessage({ type: "text", text: "hi agent" });

    const result = await mgr.fireMessage(messageId);
    expect(result.fired).toBe(true);
    expect(result.childIds).toHaveLength(1);

    const parent = await queries.messages.findById(pool, messageId);
    expect(parent?.state).toBe("succeeded");
    expect(parent?.startedAt).toBeDefined();
    expect(parent?.endedAt).toBeDefined();

    // Child content is structured events, with stderr interleaved.
    const child = await queries.messages.findById(pool, result.childIds[0]);
    const content = child!.content as {
      type: string;
      log: Array<{ kind: string; event?: { type: string }; line?: string }>;
    };
    expect(content.type).toBe("events");
    expect(content.log.map((e) => e.kind)).toEqual(["event", "event", "stderr", "event"]);
    expect(content.log[0].event?.type).toBe("step_start");
    expect(content.log[2].line).toBe("diagnostic noise");

    const updated = events.filter((e) => e.type === "message.updated");
    expect(updated.length).toBeGreaterThanOrEqual(2);
    const appended = events.filter((e) => e.type === "message.appended");
    expect(appended.length).toBe(1);
  });

  it("summary_request content produces a summary-content child", async () => {
    let capturedPrompt = "";
    let capturedRunMode: string | undefined;
    const mgr = createRunManager({
      pool,
execRunFn: async (messageId, _a, prompt, onLog, runOpts) => {
        capturedPrompt = prompt;
        capturedRunMode = runOpts?.agentFileInput.runMode;
        onLog({ runId: messageId, seq: 0, kind: "stdout", payload: "Summary about the vacation chat." });
        return { exitCode: 0 };
      },
    });

    const messageId = await insertPendingMessage({ type: "summary_request" });
    const result = await mgr.fireMessage(messageId);
    expect(result.childIds).toHaveLength(1);
    const child = await queries.messages.findById(pool, result.childIds[0]);
    const content = child!.content as { type: string; body?: string };
    expect(content.type).toBe("summary");
    expect(content.body).toContain("vacation");
    expect(capturedPrompt).toContain("Refresh this chat's running summary.");
    expect(capturedPrompt).toContain("do not create files, write artifacts, or attach artifacts");
    expect(capturedRunMode).toBe("summary");
  });

  it("summary output uses the final text event instead of planning chatter", async () => {
    const mgr = createRunManager({
      pool,
execRunFn: async (messageId, _a, _p, onLog) => {
        onLog({ runId: messageId, seq: 0, kind: "stdout", payload: JSON.stringify({ type: "text", part: { text: "I will inspect the chat first." } }) });
        onLog({ runId: messageId, seq: 1, kind: "stdout", payload: JSON.stringify({ type: "tool_use", part: { tool: "bash" } }) });
        onLog({ runId: messageId, seq: 2, kind: "stdout", payload: JSON.stringify({ type: "text", part: { text: "# Chat Summary — Final\n\n## What we built\n\nA clean summary." } }) });
        return { exitCode: 0 };
      },
    });

    const messageId = await insertPendingMessage({ type: "summary_request" });
    const result = await mgr.fireMessage(messageId);
    const child = await queries.messages.findById(pool, result.childIds[0]);
    const content = child!.content as { type: string; body?: string };
    expect(content.body).toBe("# Chat Summary — Final\n\n## What we built\n\nA clean summary.");
  });

  it("is idempotent — second fire on same message is a no-op", async () => {
    const mgr = createRunManager({
      pool,
execRunFn: async () => ({ exitCode: 0 }),
    });

    const messageId = await insertPendingMessage({ type: "text", text: "idempotent" });
    const a = await mgr.fireMessage(messageId);
    expect(a.fired).toBe(true);

    const b = await mgr.fireMessage(messageId);
    expect(b.fired).toBe(false);
    expect(b.childIds).toHaveLength(0);
  });

  it("unknown messageId: fired=false, no side effects", async () => {
    const mgr = createRunManager({
      pool,
execRunFn: async () => ({ exitCode: 0 }),
    });
    const result = await mgr.fireMessage("msg_does_not_exist");
    expect(result.fired).toBe(false);
  });

  it("exec failure: message transitions to failed", async () => {
    const mgr = createRunManager({
      pool,
execRunFn: async () => ({ exitCode: 1 }),
    });

    const messageId = await insertPendingMessage({ type: "text", text: "will fail" });
    await mgr.fireMessage(messageId);
    const msg = await queries.messages.findById(pool, messageId);
    expect(msg?.state).toBe("failed");
  });

  it("agent_turn resolves the referenced user message's text as the prompt (G2)", async () => {
    let capturedPrompt = "";
    const mgr = createRunManager({
      pool,
execRunFn: async (_id, _agentId, prompt, onLog) => {
        capturedPrompt = prompt;
        onLog({ runId: _id, seq: 0, kind: "stdout", payload: "ok" });
        return { exitCode: 0 };
      },
    });

    const userId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content)
       VALUES (?, ?, 'user', ?)`,
      [userId, chatId, JSON.stringify({ type: "text", text: "resolve me please" })],
    );

    const triggerId = await insertPendingMessage({ type: "agent_turn", userMessageId: userId });
    await mgr.fireMessage(triggerId);

    expect(capturedPrompt).toBe("resolve me please");
  });

  it("populates agentFileInput.goal and chatId from chats.goal so the system prompt sees the goal", async () => {
    let captured: { goal?: unknown; chatId?: unknown } = {};
    const mgr = createRunManager({
      pool,
      execRunFn: async (_id, _agentId, _prompt, onLog, opts) => {
        captured = {
          goal: opts?.agentFileInput.goal,
          chatId: opts?.agentFileInput.chatId,
        };
        onLog({ runId: _id, seq: 0, kind: "stdout", payload: "ok" });
        return { exitCode: 0 };
      },
    });

    await pool.query(`UPDATE chats SET goal = 'document' WHERE id = ?`, [chatId]);
    const messageId = await insertPendingMessage({ type: "text", text: "with goal set" });
    await mgr.fireMessage(messageId);

    expect(captured.goal).toBe("document");
    expect(captured.chatId).toBe(chatId);
  });

  it("agentFileInput.goal is null when chats.goal is unset", async () => {
    let capturedGoal: unknown = "sentinel";
    const mgr = createRunManager({
      pool,
      execRunFn: async (_id, _agentId, _prompt, onLog, opts) => {
        capturedGoal = opts?.agentFileInput.goal;
        onLog({ runId: _id, seq: 0, kind: "stdout", payload: "ok" });
        return { exitCode: 0 };
      },
    });

    await pool.query(`UPDATE chats SET goal = NULL WHERE id = ?`, [chatId]);
    const messageId = await insertPendingMessage({ type: "text", text: "no goal" });
    await mgr.fireMessage(messageId);

    expect(capturedGoal).toBeNull();
  });
});

describe("fireMessage on kind='task'", () => {
  it("each fire creates a task_run child; the task definition is not mutated", async () => {
    const events: WsEvent[] = [];
    const mgr = createRunManager({
      pool,
emit: (evt) => events.push(evt),
      execRunFn: async (_id, _agentId, _prompt, onLog) => {
        onLog({ runId: _id, seq: 0, kind: "stdout", payload: "ok" });
        return { exitCode: 0 };
      },
    });

    const taskId = await insertTask({
      content: { type: "text", text: "do the thing" },
      cron: "*/5 * * * *",
    });

    const a = await mgr.fireMessage(taskId);
    expect(a.fired).toBe(true);
    const b = await mgr.fireMessage(taskId);
    expect(b.fired).toBe(true);

    // After both runs complete, parent task is back to pending with no
    // started_at — runs hold per-fire state, parent tracks schedule status.
    const parent = await queries.messages.findById(pool, taskId);
    expect(parent?.state).toBe("pending");
    expect(parent?.startedAt).toBeUndefined();
    expect(parent?.endedAt).toBeUndefined();

    // Two task_run children, each with its own terminal state and timing.
    const runs = await listTaskRuns(taskId);
    expect(runs).toHaveLength(2);
    expect(runs[0].state).toBe("succeeded");
    expect(runs[1].state).toBe("succeeded");
    expect(runs[0].startedAt).not.toBeNull();
    expect(runs[1].startedAt).not.toBeNull();
    expect(runs[0].id).not.toBe(runs[1].id);

    // The agent output child of each fire is parented to its run, not the
    // task definition. result.childIds is the agent output id from the
    // most recent fire.
    const lastOutput = await queries.messages.findById(pool, b.childIds[0]);
    expect(lastOutput?.parentId).toBe(runs[1].id);
  });

  it("one-shot task transitions parent to terminal and clears executeAt", async () => {
    const mgr = createRunManager({
      pool,
execRunFn: async (_id, _agentId, _prompt, onLog) => {
        onLog({ runId: _id, seq: 0, kind: "stdout", payload: "done" });
        return { exitCode: 0 };
      },
    });

    const taskId = await insertTask({
      content: { type: "text", text: "one-shot" },
      executeAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await mgr.fireMessage(taskId);

    const parent = await queries.messages.findById(pool, taskId);
    expect(parent?.state).toBe("succeeded");
    expect(parent?.executeAt).toBeUndefined();

    const runs = await listTaskRuns(taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("succeeded");
  });

  it("task run failure marks the run failed and the one-shot parent failed", async () => {
    const mgr = createRunManager({
      pool,
execRunFn: async () => ({ exitCode: 1 }),
    });

    const taskId = await insertTask({
      content: { type: "text", text: "boom" },
      executeAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await mgr.fireMessage(taskId);

    const parent = await queries.messages.findById(pool, taskId);
    expect(parent?.state).toBe("failed");
    const runs = await listTaskRuns(taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("failed");
  });

  it("parent task state is running while task_run is in-flight and stays running after (user controls status)", async () => {
    let resolveRun!: () => void;
    const runStarted = new Promise<void>((r) => { resolveRun = r; });
    let allowFinish!: () => void;
    const runBlocked = new Promise<void>((r) => { allowFinish = r; });

    const events: WsEvent[] = [];
    const mgr = createRunManager({
      pool,
      emit: (evt) => events.push(evt),
      execRunFn: async (_id, _a, _p, onLog) => {
        onLog({ runId: _id, seq: 0, kind: "stdout", payload: "start" });
        resolveRun();
        await runBlocked;
        return { exitCode: 0 };
      },
    });

    const taskId = await insertTask({
      content: { type: "text", text: "active check" },
    });

    const fire = mgr.fireMessage(taskId);
    await runStarted;

    // While the run is in-flight the parent task must be 'running'.
    const duringRun = await queries.messages.findById(pool, taskId);
    expect(duringRun?.state).toBe("running");

    allowFinish();
    await fire;

    // After the run completes the parent stays 'running' — the user placed
    // it in Active and owns its status from here.
    const afterRun = await queries.messages.findById(pool, taskId);
    expect(afterRun?.state).toBe("running");
  });

  it("user-created unscheduled task: parent stays running after run (user owns status)", async () => {
    const mgr = createRunManager({
      pool,
      execRunFn: async (_id, _a, _p, onLog) => {
        onLog({ runId: _id, seq: 0, kind: "stdout", payload: "done" });
        return { exitCode: 0 };
      },
    });

    const taskId = await insertTask({
      content: { type: "text", text: "user todo" },
      // no executeAt, no cron — plain user-created task
    });

    await mgr.fireMessage(taskId);

    const parent = await queries.messages.findById(pool, taskId);
    expect(parent?.state).toBe("running");

    const runs = await listTaskRuns(taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("succeeded");
  });

  it("agent-created unscheduled task: parent state transitions to terminal after run", async () => {
    const mgr = createRunManager({
      pool,
      execRunFn: async (_id, _a, _p, onLog) => {
        onLog({ runId: _id, seq: 0, kind: "stdout", payload: "done" });
        return { exitCode: 0 };
      },
    });

    const taskId = await insertTask({
      content: { type: "text", text: "agent todo" },
      role: "agent",
      // no executeAt, no cron
    });

    await mgr.fireMessage(taskId);

    const parent = await queries.messages.findById(pool, taskId);
    expect(parent?.state).toBe("succeeded");
    expect(parent?.executeAt).toBeUndefined();
  });

  it("declines to start a second concurrent run for the same task", async () => {
    // Block the first fire inside execRunFn so its run is still "running"
    // when the second fire arrives. The second should see the in-flight
    // run via startTaskRun's lock and bail out without creating a row.
    let release: (() => void) | null = null;
    const blocked = new Promise<void>((r) => { release = r; });
    const mgr = createRunManager({
      pool,
execRunFn: async (_id, _a, _p, onLog) => {
        onLog({ runId: _id, seq: 0, kind: "stdout", payload: "" });
        await blocked;
        return { exitCode: 0 };
      },
    });

    const taskId = await insertTask({
      content: { type: "text", text: "race" },
      cron: "*/5 * * * *",
    });

    const first = mgr.fireMessage(taskId);
    // Yield to the event loop so first proceeds past startTaskRun + claim.
    await new Promise((r) => setTimeout(r, 25));

    const second = await mgr.fireMessage(taskId);
    expect(second.fired).toBe(false);
    expect(second.childIds).toHaveLength(0);

    release!();
    const firstResult = await first;
    expect(firstResult.fired).toBe(true);

    const runs = await listTaskRuns(taskId);
    expect(runs).toHaveLength(1);
  });
});

describe("scheduleSummary", () => {
  async function clearSummaries(): Promise<void> {
    await pool.query(
      `DELETE FROM messages WHERE chat_id = ? AND json_extract(content, '$.type') = 'summary_request'`,
      [chatId],
    );
  }

  it("creates a pending summary_request message with a future execute_at", async () => {
    const mgr = createRunManager({
      pool,
      execRunFn: async () => ({ exitCode: 0 }),
    });
    await clearSummaries();

    await mgr.scheduleSummary(chatId);

    const { rows } = await pool.query(
      `SELECT id, state, execute_at FROM messages
       WHERE chat_id = ? AND json_extract(content, '$.type') = 'summary_request'`,
      [chatId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("pending");
    expect(new Date(rows[0].execute_at as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("cancels the previous summary_request before scheduling a new one", async () => {
    const mgr = createRunManager({ pool, execRunFn: async () => ({ exitCode: 0 }) });
    await clearSummaries();

    await mgr.scheduleSummary(chatId);
    const first = (await pool.query(
      `SELECT id FROM messages WHERE chat_id = ? AND json_extract(content, '$.type') = 'summary_request'`,
      [chatId],
    )).rows[0].id as string;

    await mgr.scheduleSummary(chatId);
    const after = (await pool.query(
      `SELECT id FROM messages WHERE chat_id = ? AND json_extract(content, '$.type') = 'summary_request'`,
      [chatId],
    )).rows;
    expect(after).toHaveLength(1);
    expect(after[0].id).not.toBe(first);
  });
});

describe("workspace.synced", () => {
  it("emits workspace.synced after a message fires successfully", async () => {
    const events: WsEvent[] = [];
    const mgr = createRunManager({
      pool,
      emit: (evt) => events.push(evt),
      execRunFn: async (messageId, _a, _p, onLog) => {
        onLog({ runId: messageId, seq: 0, kind: "stdout", payload: JSON.stringify({ type: "text", part: { text: "done" } }) });
        return { exitCode: 0 };
      },
    });

    const messageId = await insertPendingMessage({ type: "text", text: "do something" });
    await mgr.fireMessage(messageId);

    const synced = events.filter((e) => e.type === "workspace.synced");
    expect(synced.length).toBe(1);
  });
});

describe("cancelMessage", () => {
  it("removes the row", async () => {
    const mgr = createRunManager({ pool, execRunFn: async () => ({ exitCode: 0 }) });
    await mgr.scheduleSummary(chatId);

    const { rows } = await pool.query(
      `SELECT id FROM messages WHERE chat_id = ? AND json_extract(content, '$.type') = 'summary_request'`,
      [chatId],
    );
    const messageId = rows[0].id as string;

    await mgr.cancelMessage(messageId);

    expect(await queries.messages.findById(pool, messageId)).toBeNull();
  });
});
