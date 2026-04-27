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
let wsId: string;
let agentId: string;

beforeAll(async () => {
  pool = await setupTestDb();
  const userId = generateId("user");
  await users.insert(pool, { id: userId, username: "chatowner", passwordHash: "h", email: "chat@example.com" });
  agentId = generateId("agent");
  await agents.insert(pool, { id: agentId, userId, name: "ChatAgent" });
  wsId = generateId("workspace");
  await workspaces.insert(pool, { id: wsId, userId, name: "ChatWS", path: `chatws-${wsId.slice(-6)}` });
  // Enable the agent in the workspace so chats referencing it are valid under M3.
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [wsId, agentId],
  );
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("chats queries", () => {
  const chatId = generateId("chat");

  it("inserts a chat", async () => {
    const chat = await chats.insert(pool, {
      id: chatId,
      workspaceId: wsId,
      agentId,
      title: "Hello",
    });
    expect(chat.id).toBe(chatId);
    expect(chat.title).toBe("Hello");
    expect(chat.awaitingUser).toBe(false);
  });

  it("finds by id", async () => {
    const chat = await chats.findById(pool, chatId);
    expect(chat).not.toBeNull();
    expect(chat!.workspaceId).toBe(wsId);
  });

  it("lists with latest message", async () => {
    const list = await chats.listWithLatestMessage(pool, wsId);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it("iconKind picks the newest non-chat kind, with chat as fallback", async () => {
    // Chat A: starts as chat, later gets a task. iconKind should be 'task'.
    const chatA = generateId("chat");
    await chats.insert(pool, { id: chatA, workspaceId: wsId, agentId, title: "Chat → task" });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: chatA,
      role: "user",
      content: { type: "text", text: "hi" },
      kind: "chat",
    });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: chatA,
      role: "user",
      content: { type: "text", text: "do the thing" },
      kind: "task",
    });

    // Chat B: starts as task, then plain chat replies. The task icon should
    // stick because the newest non-chat kind is still 'task'.
    const chatB = generateId("chat");
    await chats.insert(pool, { id: chatB, workspaceId: wsId, agentId, title: "Task → chat" });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: chatB,
      role: "user",
      content: { type: "text", text: "do the thing" },
      kind: "task",
    });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: chatB,
      role: "user",
      content: { type: "text", text: "follow-up" },
      kind: "chat",
    });

    // Chat C: only chat messages → fallback to 'chat'.
    const chatC = generateId("chat");
    await chats.insert(pool, { id: chatC, workspaceId: wsId, agentId, title: "Plain chat" });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: chatC,
      role: "user",
      content: { type: "text", text: "just chatting" },
      kind: "chat",
    });

    const list = await chats.listWithLatestMessage(pool, wsId);
    expect(list.find((c) => c.id === chatA)?.iconKind).toBe("task");
    expect(list.find((c) => c.id === chatB)?.iconKind).toBe("task");
    expect(list.find((c) => c.id === chatC)?.iconKind).toBe("chat");
  });

  it("updates meta", async () => {
    const updated = await chats.updateMeta(pool, chatId, { title: "Renamed Chat" });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Renamed Chat");
  });

  it("marks as read", async () => {
    await chats.markRead(pool, chatId);
    const chat = await chats.findById(pool, chatId);
    expect(chat!.unread).toBe(false);
  });

  it("sets awaiting user", async () => {
    await chats.setAwaitingUser(pool, chatId, true);
    const chat = await chats.findById(pool, chatId);
    expect(chat!.awaitingUser).toBe(true);
  });

  it("cascades delete when workspace is deleted", async () => {
    const userId2 = generateId("user");
    await users.insert(pool, { id: userId2, username: "cascadeuser", passwordHash: "h", email: "cascade@example.com" });
    const wsId2 = generateId("workspace");
    await workspaces.insert(pool, { id: wsId2, userId: userId2, name: "CascadeWS", path: `cascadews-${wsId2.slice(-6)}` });
    // Enable the agent in the new workspace so the chat insert validation passes.
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [wsId2, agentId],
    );
    const chatId2 = generateId("chat");
    await chats.insert(pool, { id: chatId2, workspaceId: wsId2, agentId, title: "Will be deleted" });

    await pool.query("DELETE FROM workspaces WHERE id = $1", [wsId2]);
    const chat = await chats.findById(pool, chatId2);
    expect(chat).toBeNull();
  });
});
