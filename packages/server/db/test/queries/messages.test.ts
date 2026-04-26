import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { generateId } from "@desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as users from "../../src/queries/users.js";
import * as agents from "../../src/queries/agents.js";
import * as workspaces from "../../src/queries/workspaces.js";
import * as chats from "../../src/queries/chats.js";
import * as messages from "../../src/queries/messages.js";

let pool: pg.Pool;
let chatId: string;

beforeAll(async () => {
  pool = await setupTestDb();
  const userId = generateId("user");
  await users.insert(pool, { id: userId, username: "msgowner", passwordHash: "h", email: "msg@example.com" });
  const agentId = generateId("agent");
  await agents.insert(pool, { id: agentId, userId, name: "MsgAgent" });
  const wsId = generateId("workspace");
  await workspaces.insert(pool, { id: wsId, userId, name: "MsgWS", path: `msgws-${wsId.slice(-6)}` });
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [wsId, agentId],
  );
  chatId = generateId("chat");
  await chats.insert(pool, { id: chatId, workspaceId: wsId, agentId, title: "MsgChat" });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("messages queries", () => {
  it("inserts a message and marks chat unread", async () => {
    await chats.markRead(pool, chatId);
    const msg = await messages.insert(pool, {
      id: generateId("message"),
      chatId,
      role: "user",
      content: { type: "text", text: "Hello" },
    });
    expect(msg.chatId).toBe(chatId);
    expect(msg.role).toBe("user");

    const chat = await chats.findById(pool, chatId);
    expect(chat!.unread).toBe(true);
  });

  it("lists by chat with cursor pagination", async () => {
    // Insert a few more
    for (let i = 0; i < 3; i++) {
      await messages.insert(pool, {
        id: generateId("message"),
        chatId,
        role: "agent",
        content: { type: "text", text: `Reply ${i}` },
      });
    }

    const page1 = await messages.listByChat(pool, chatId, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await messages.listByChat(pool, chatId, { cursor: page1.nextCursor, limit: 2 });
    expect(page2.items.length).toBeGreaterThanOrEqual(1);
  });

  it("cascades delete when chat is deleted", async () => {
    const { rows } = await messages.listByChat(pool, chatId);
    expect(rows).toBeUndefined(); // it returns { items, nextCursor }

    await pool.query("DELETE FROM chats WHERE id = $1", [chatId]);
    const result = await messages.listByChat(pool, chatId);
    expect(result.items).toHaveLength(0);
  });
});
