import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateId } from "@agent-desk/shared";
import { type Pool } from "../../src/pool.js";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as users from "../../src/queries/users.js";
import * as agents from "../../src/queries/agents.js";
import * as workspaces from "../../src/queries/workspaces.js";
import * as chats from "../../src/queries/chats.js";
import * as messages from "../../src/queries/messages.js";

let pool: Pool;
let workspaceId: string;
let agentId: string;
let anchorChatId: string;

beforeAll(async () => {
  pool = await setupTestDb();
  const userId = generateId("user");
  await users.insert(pool, {
    id: userId,
    username: "owner",
    passwordHash: "h",
    email: "owner@example.com",
  });
  agentId = generateId("agent");
  await agents.insert(pool, { id: agentId, userId, name: "Agent" });
  workspaceId = generateId("workspace");
  await workspaces.insert(pool, {
    id: workspaceId,
    userId,
    name: "WS",
    path: `ws-${workspaceId.slice(-6)}`,
  });
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id)
     VALUES (?, ?) ON CONFLICT DO NOTHING`,
    [workspaceId, agentId],
  );
  anchorChatId = generateId("chat");
  await chats.insert(pool, { id: anchorChatId, workspaceId, agentId, title: "Anchor" });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("decorateMessagesWithTaskStatus", () => {
  it("leaves non-task rows untouched", async () => {
    const id = generateId("message");
    const inserted = await messages.insert(pool, {
      id,
      chatId: anchorChatId,
      role: "user",
      content: { type: "text", text: "hi" },
    });
    const [decorated] = await messages.decorateMessagesWithTaskStatus(pool, [inserted]);
    expect(decorated.taskStatus).toBeUndefined();
  });

  it("returns 'todo' for an idle task with no thread and no runs", async () => {
    await chats.markRead(pool, anchorChatId);
    const id = generateId("message");
    const inserted = await messages.insert(pool, {
      id,
      chatId: anchorChatId,
      role: "user",
      content: { type: "text", text: "plain task" },
      kind: "task",
      state: "pending",
    });
    const [decorated] = await messages.decorateMessagesWithTaskStatus(pool, [inserted]);
    expect(decorated.taskStatus).toBe("todo");
  });

  it("returns 'active' when the task's thread chat has a running agent_turn — the source of the cross-surface drift", async () => {
    // Reproduces the exact bug from the screenshot: the Tasks page sees
    // the thread chat's `running=true` and shows Active, while inline
    // surfaces that only had the anchor chat in their lookup showed Open.
    const taskId = generateId("message");
    const threadChatId = generateId("chat");
    await chats.insert(pool, {
      id: threadChatId,
      workspaceId,
      agentId,
      title: "Thread",
    });
    await messages.insert(pool, {
      id: taskId,
      chatId: anchorChatId,
      role: "user",
      content: { type: "text", text: "build markdown app" },
      kind: "task",
      state: "pending",
    });
    await messages.setThreadChatId(pool, taskId, threadChatId);
    // Drop a running agent_turn into the thread chat — same shape the
    // chats query uses to derive `running`.
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, kind, state)
       VALUES (?, ?, 'system', '{"type":"agent_turn","userMessageId":"u"}', 'chat', 'running')`,
      [generateId("message"), threadChatId],
    );

    const task = (await messages.findById(pool, taskId))!;
    const [decorated] = await messages.decorateMessagesWithTaskStatus(pool, [task]);
    expect(decorated.taskStatus).toBe("active");
  });

  it("returns 'active' when a child task_run is running", async () => {
    const taskId = generateId("message");
    await messages.insert(pool, {
      id: taskId,
      chatId: anchorChatId,
      role: "user",
      content: { type: "text", text: "scheduled task" },
      kind: "task",
      state: "pending",
    });
    const runId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, kind, state, parent_id)
       VALUES (?, ?, 'user', '{"type":"text","text":"run"}', 'task_run', 'running', ?)`,
      [runId, anchorChatId, taskId],
    );
    const task = (await messages.findById(pool, taskId))!;
    const [decorated] = await messages.decorateMessagesWithTaskStatus(pool, [task]);
    expect(decorated.taskStatus).toBe("active");
  });

  it("returns 'complete' for cancelled (user marked done) tasks regardless of other signals", async () => {
    const taskId = generateId("message");
    await messages.insert(pool, {
      id: taskId,
      chatId: anchorChatId,
      role: "user",
      content: { type: "text", text: "done already" },
      kind: "task",
      state: "cancelled",
    });
    const task = (await messages.findById(pool, taskId))!;
    const [decorated] = await messages.decorateMessagesWithTaskStatus(pool, [task]);
    expect(decorated.taskStatus).toBe("complete");
  });

  it("returns 'scheduled' when executeAt is set and no run is in flight", async () => {
    const taskId = generateId("message");
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await messages.insert(pool, {
      id: taskId,
      chatId: anchorChatId,
      role: "user",
      content: { type: "text", text: "later" },
      kind: "task",
      state: "pending",
      executeAt: future,
    });
    const task = (await messages.findById(pool, taskId))!;
    const [decorated] = await messages.decorateMessagesWithTaskStatus(pool, [task]);
    expect(decorated.taskStatus).toBe("scheduled");
  });

  it("batches efficiently: one decorator call handles many tasks across many chats", async () => {
    const tasks: Awaited<ReturnType<typeof messages.findById>>[] = [];
    for (let i = 0; i < 5; i++) {
      const chatId = generateId("chat");
      await chats.insert(pool, { id: chatId, workspaceId, agentId, title: `Bulk ${i}` });
      const taskId = generateId("message");
      await messages.insert(pool, {
        id: taskId,
        chatId,
        role: "user",
        content: { type: "text", text: `bulk ${i}` },
        kind: "task",
        state: "pending",
      });
      tasks.push(await messages.findById(pool, taskId));
    }
    const decorated = await messages.decorateMessagesWithTaskStatus(
      pool,
      tasks.map((t) => t!),
    );
    expect(decorated).toHaveLength(5);
    for (const m of decorated) expect(m.taskStatus).toBe("todo");
  });
});
