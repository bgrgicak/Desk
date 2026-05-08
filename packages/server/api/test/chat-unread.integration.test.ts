/**
 * Integration tests for chat unread status.
 *
 * Verifies that:
 * 1. Inserting a message sets chat.unread = true
 * 2. PATCH /chats/:id with { unread: false } clears unread
 * 3. PATCH with other fields + unread=false works correctly
 * 4. New messages after marking read re-set unread to true
 * 5. Internal messages (summary, summary_request, agent_turn) do NOT
 *    set chat.unread = true
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations, queries, hashPassword } from "@agent-desk/db";
import { ensureLayout, type StorageContext } from "@agent-desk/storage";
import { generateId } from "@agent-desk/shared";
import {
  sendMessage,
  patchChat,
} from "../src/routes/chats.js";

let pool: Pool;
let home: string;
let dbPath: string;
let userId: string;
let workspaceId: string;
let agentId: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-chat-unread-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-chat-unread-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "unread_user",
    passwordHash: await hashPassword("pw"),
    email: "unread@example.com",
  });

  workspaceId = generateId("workspace");
  await queries.workspaces.insert(pool, {
    id: workspaceId,
    userId,
    name: "ws-unread",
    description: "",
    icon: "",
  });

  agentId = generateId("agent");
  await queries.agents.insert(pool, {
    id: agentId,
    userId,
    name: "agent-unread",
    model: "opencode/big-pickle",
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
    title: "unread test",
  });
  return chatId;
}

describe("chat unread status", () => {
  it("new chat starts as not unread", async () => {
    const chatId = await freshChat();
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat!.unread).toBe(false);
  });

  it("inserting a message sets unread to true", async () => {
    const chatId = await freshChat();
    await sendMessage(pool, chatId, { content: "hello" }, () => {});
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat!.unread).toBe(true);
  });

  it("PATCH with unread=false clears the unread flag", async () => {
    const chatId = await freshChat();
    // First make it unread by sending a message
    await sendMessage(pool, chatId, { content: "hello" }, () => {});
    const before = await queries.chats.findById(pool, chatId);
    expect(before!.unread).toBe(true);

    // Mark as read via patchChat
    const result = await patchChat(pool, chatId, { unread: false });
    expect(result.unread).toBe(false);

    // Verify in DB
    const after = await queries.chats.findById(pool, chatId);
    expect(after!.unread).toBe(false);
  });

  it("PATCH with unread=false and other fields works correctly", async () => {
    const chatId = await freshChat();
    await sendMessage(pool, chatId, { content: "hello" }, () => {});

    const result = await patchChat(pool, chatId, {
      unread: false,
      title: "New Title",
    });
    expect(result.unread).toBe(false);
    expect(result.title).toBe("New Title");
  });

  it("new message after marking read re-sets unread to true", async () => {
    const chatId = await freshChat();

    // Send message → unread=true
    await sendMessage(pool, chatId, { content: "first" }, () => {});
    expect((await queries.chats.findById(pool, chatId))!.unread).toBe(true);

    // Mark as read → unread=false
    await patchChat(pool, chatId, { unread: false });
    expect((await queries.chats.findById(pool, chatId))!.unread).toBe(false);

    // Send another message → unread=true again
    await sendMessage(pool, chatId, { content: "second" }, () => {});
    expect((await queries.chats.findById(pool, chatId))!.unread).toBe(true);
  });

  it("unread appears in listWithLatestMessage", async () => {
    const chatId = await freshChat();
    await sendMessage(pool, chatId, { content: "hello" }, () => {});

    const list = await queries.chats.listWithLatestMessage(pool, workspaceId);
    const found = list.find((c) => c.id === chatId);
    expect(found).toBeDefined();
    expect(found!.unread).toBe(true);

    // Mark read and re-check
    await patchChat(pool, chatId, { unread: false });
    const list2 = await queries.chats.listWithLatestMessage(pool, workspaceId);
    const found2 = list2.find((c) => c.id === chatId);
    expect(found2!.unread).toBe(false);
  });

  it("patchChat with only unread=false returns 404 for missing chat", async () => {
    await expect(patchChat(pool, "nonexistent", { unread: false }))
      .rejects.toThrow(/not found/i);
  });

  // ── Internal messages should NOT trigger unread ─────────────────────────────

  it("inserting an agent_turn message does not set unread", async () => {
    const chatId = await freshChat();
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId,
      role: "system",
      content: { type: "agent_turn", userMessageId: "msg_placeholder" },
      state: "pending",
    });
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat!.unread).toBe(false);
  });

  it("inserting a summary_request message does not set unread", async () => {
    const chatId = await freshChat();
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId,
      role: "system",
      content: { type: "summary_request" },
      state: "pending",
      kind: "summary",
    });
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat!.unread).toBe(false);
  });

  it("inserting a summary message does not set unread", async () => {
    const chatId = await freshChat();
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId,
      role: "agent",
      content: { type: "summary", body: "# Chat Summary\nThis is a test." },
    });
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat!.unread).toBe(false);
  });

  it("internal message does not flip unread back after marking read", async () => {
    const chatId = await freshChat();
    // Make it unread via a real user message
    await sendMessage(pool, chatId, { content: "hello" }, () => {});
    expect((await queries.chats.findById(pool, chatId))!.unread).toBe(true);

    // Mark read
    await patchChat(pool, chatId, { unread: false });
    expect((await queries.chats.findById(pool, chatId))!.unread).toBe(false);

    // Insert an internal message — should stay read
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId,
      role: "agent",
      content: { type: "summary", body: "# Updated summary" },
    });
    expect((await queries.chats.findById(pool, chatId))!.unread).toBe(false);
  });

  it("agent text response still sets unread", async () => {
    const chatId = await freshChat();
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId,
      role: "agent",
      content: { type: "text", text: "Hello from the agent!" },
    });
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat!.unread).toBe(true);
  });
});
