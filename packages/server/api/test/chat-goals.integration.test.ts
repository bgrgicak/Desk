/**
 * Integration tests for goal persistence on `POST /chats/:id/messages`.
 *
 * Real Postgres (well, real SQLite via the same Pool harness used by the
 * chat-delete test). Exercises both the JSON path (`sendMessage`) and
 * the multipart path (`buildSendMessageBodyFromForm`) since both have to
 * write to `chats.goal` for the column to be the source of truth used
 * by the scheduler in Task 4.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations, queries, hashPassword } from "@agent-desk/db";
import { ensureLayout, type StorageContext } from "@agent-desk/storage";
import { generateId } from "@agent-desk/shared";
import {
  buildSendMessageBodyFromForm,
  sendMessage,
} from "../src/routes/chats.js";

let pool: Pool;
let home: string;
let dbPath: string;
let userId: string;
let workspaceId: string;
let agentId: string;
let storage: StorageContext;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-chat-goals-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-chat-goals-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;
  storage = { pool, home };

  userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "goals_user",
    passwordHash: await hashPassword("pw"),
    email: "goals@example.com",
  });

  workspaceId = generateId("workspace");
  await queries.workspaces.insert(pool, {
    id: workspaceId,
    userId,
    name: "ws-goals",
    description: "",
    icon: "",
  });

  agentId = generateId("agent");
  await queries.agents.insert(pool, {
    id: agentId,
    userId,
    name: "agent-goals",
    instructions: "",
    model: "anthropic/claude-sonnet-4-5",
  });
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`,
    [workspaceId, agentId],
  );
});

afterAll(async () => {
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
});

async function freshChat(): Promise<string> {
  const chatId = generateId("chat");
  await queries.chats.insert(pool, {
    id: chatId,
    workspaceId,
    agentId,
    title: "goal test",
  });
  return chatId;
}

describe("goal persistence on send", () => {
  it("JSON path: send with goal sets chats.goal", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "build me a doc", goal: "document" },
      () => {},
    );
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBe("document");
  });

  it("JSON path: task send with goal sets chats.goal", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "finish this", kind: "task", goal: "task" },
      () => {},
    );
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBe("task");
  });

  it("JSON path: invalid explicit goal is rejected", async () => {
    const chatId = await freshChat();
    await expect(sendMessage(
      pool,
      chatId,
      { content: "hello", goal: "not-a-goal" },
      () => {},
    )).rejects.toThrow(/Invalid chat goal/);
  });

  it("JSON path: send without goal persists an inferred goal", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "let's build a calendar app" },
      () => {},
    );
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBe("app");
  });

  it("JSON path: send without a matching goal leaves chats.goal empty", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "hello" },
      () => {},
    );
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBeUndefined();
  });

  it("JSON path: agent-role send without goal does not persist an inferred goal", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "build a dashboard", kind: "task" },
      () => {},
      { role: "agent" },
    );
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBeUndefined();
  });

  it("JSON path: subsequent send without goal does not overwrite the column", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "first", goal: "document" },
      () => {},
    );
    await sendMessage(
      pool,
      chatId,
      { content: "second" },
      () => {},
    );
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBe("document");
  });

  it("JSON path: explicit null goal clears chats.goal and prevents inference on that send", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "first", goal: "document" },
      () => {},
    );
    await sendMessage(
      pool,
      chatId,
      { content: "build me an app", goal: null },
      () => {},
    );
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBeUndefined();
  });

  it("JSON path: message content does not embed the goal", async () => {
    const chatId = await freshChat();
    const { userMessage } = await sendMessage(
      pool,
      chatId,
      { content: "hello", goal: "image" },
      () => {},
    );
    // The goal lives on chats.goal, not in the message body.
    expect(userMessage.content).toEqual({ type: "text", text: "hello" });
  });

  it("multipart path: FormData with goal field is propagated and persisted", async () => {
    const chatId = await freshChat();
    const form = new FormData();
    form.set("content", "via multipart");
    form.set("goal", "data");

    const body = await buildSendMessageBodyFromForm(storage, chatId, form);
    expect(body).toMatchObject({ content: "via multipart", goal: "data" });

    await sendMessage(pool, chatId, body, () => {});
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBe("data");
  });

  it("multipart path: FormData without goal persists an inferred goal", async () => {
    const chatId = await freshChat();
    const form = new FormData();
    form.set("content", "show me a portfolio site");

    const body = await buildSendMessageBodyFromForm(storage, chatId, form);
    expect(body).toMatchObject({ content: "show me a portfolio site" });

    await sendMessage(pool, chatId, body, () => {});
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBe("site");
  });

  it("multipart path: empty goal field clears chats.goal", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "first", goal: "document" },
      () => {},
    );
    const form = new FormData();
    form.set("content", "build me an app");
    form.set("goal", "");

    const body = await buildSendMessageBodyFromForm(storage, chatId, form);
    expect(body).toMatchObject({ content: "build me an app", goal: null });

    await sendMessage(pool, chatId, body, () => {});
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBeUndefined();
  });
});
