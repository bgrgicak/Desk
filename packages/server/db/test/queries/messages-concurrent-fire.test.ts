import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type Pool } from "../../src/pool.js";
import { generateId } from "@agent-desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as users from "../../src/queries/users.js";
import * as agents from "../../src/queries/agents.js";
import * as workspaces from "../../src/queries/workspaces.js";
import * as chats from "../../src/queries/chats.js";
import * as messages from "../../src/queries/messages.js";

let pool: Pool;
let chatId: string;
let taskId: string;

beforeAll(async () => {
  pool = await setupTestDb();
  const userId = generateId("user");
  await users.insert(pool, { id: userId, username: "u", passwordHash: "h", email: "u@example.com" });
  const agentId = generateId("agent");
  await agents.insert(pool, { id: agentId, userId, name: "A" });
  const wsId = generateId("workspace");
  await workspaces.insert(pool, { id: wsId, userId, name: "W", path: `w-${wsId.slice(-6)}` });
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`,
    [wsId, agentId],
  );
  chatId = generateId("chat");
  await chats.insert(pool, { id: chatId, workspaceId: wsId, agentId, title: "C" });
  taskId = generateId("message");
  await messages.insert(pool, {
    id: taskId,
    chatId,
    role: "user",
    content: { type: "text", text: "do the thing" },
    kind: "task",
    state: "pending",
  });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("startTaskRun concurrency", () => {
  it("two concurrent calls produce exactly one run; the loser sees in-flight and returns null", async () => {
    // Pre-fix: both calls threw "cannot start a transaction within a
    // transaction" because the raw `BEGIN` bypassed the pool's tx queue.
    // The pool now serializes acquirers via a FIFO queue, so the second
    // caller waits for the first to commit, then sees the new running
    // task_run via the in-flight check and returns null.
    const results = await Promise.allSettled([
      messages.startTaskRun(pool, {
        runId: generateId("message"),
        taskId,
        chatId,
        role: "user",
        content: { type: "text", text: "do the thing" },
      }),
      messages.startTaskRun(pool, {
        runId: generateId("message"),
        taskId,
        chatId,
        role: "user",
        content: { type: "text", text: "do the thing" },
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toEqual([]);
    expect(fulfilled).toHaveLength(2);

    const winners = fulfilled
      .map((r) => (r as PromiseFulfilledResult<unknown>).value)
      .filter((v) => v !== null);
    const losers = fulfilled
      .map((r) => (r as PromiseFulfilledResult<unknown>).value)
      .filter((v) => v === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // Exactly one task_run row exists for the parent task.
    const { rows } = await pool.query(
      "SELECT id FROM messages WHERE parent_id = ? AND kind = 'task_run'",
      [taskId],
    );
    expect(rows).toHaveLength(1);
  });
});
