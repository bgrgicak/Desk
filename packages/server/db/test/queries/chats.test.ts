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
     VALUES (?, ?) ON CONFLICT DO NOTHING`,
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

  it("kind picks the newest user-action kind; chat and ai_note are fallbacks", async () => {
    // Chat A: starts as chat, later gets a task. kind should be 'task'.
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
    // stick because chat is a fallback, not an action.
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

    // Chat D: task plus a later ai_note — ai_note is auto-emitted by the
    // scheduler on every turn, so it must NOT hijack the icon. kind stays
    // 'task'.
    const chatD = generateId("chat");
    await chats.insert(pool, { id: chatD, workspaceId: wsId, agentId, title: "Task + ai_note" });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: chatD,
      role: "user",
      content: { type: "text", text: "do the thing" },
      kind: "task",
    });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: chatD,
      role: "system",
      content: { type: "ai_note_request" },
      kind: "ai_note",
    });

    // Chat E: only chat + ai_note → both are fallbacks → 'chat'.
    const chatE = generateId("chat");
    await chats.insert(pool, { id: chatE, workspaceId: wsId, agentId, title: "Chat + ai_note" });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: chatE,
      role: "user",
      content: { type: "text", text: "hi" },
      kind: "chat",
    });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: chatE,
      role: "system",
      content: { type: "ai_note_request" },
      kind: "ai_note",
    });

    const list = await chats.listWithLatestMessage(pool, wsId);
    expect(list.find((c) => c.id === chatA)?.kind).toBe("task");
    expect(list.find((c) => c.id === chatB)?.kind).toBe("task");
    expect(list.find((c) => c.id === chatC)?.kind).toBe("chat");
    expect(list.find((c) => c.id === chatD)?.kind).toBe("task");
    expect(list.find((c) => c.id === chatE)?.kind).toBe("chat");
  });

  it("goalKind is inferred from the newest user-role text", async () => {
    // 'craete a randon data table' — matches the data heuristic.
    const dataChatId = generateId("chat");
    await chats.insert(pool, {
      id: dataChatId,
      workspaceId: wsId,
      agentId,
      title: "Random data table",
    });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: dataChatId,
      role: "user",
      content: { type: "text", text: "craete a randon data table" },
      kind: "chat",
    });
    // Plus a system ai_note (the auto-emitted refresh) so we prove the
    // user-role filter actually picks the user message, not the note.
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: dataChatId,
      role: "system",
      content: { type: "ai_note_request" },
      kind: "ai_note",
    });

    // Site chat — 'show me a portfolio'. (Avoid 'build/make/app' so the
    // app heuristic doesn't fire first.)
    const siteChatId = generateId("chat");
    await chats.insert(pool, {
      id: siteChatId,
      workspaceId: wsId,
      agentId,
      title: "Portfolio site",
    });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: siteChatId,
      role: "user",
      content: { type: "text", text: "show me a portfolio" },
      kind: "chat",
    });

    // Plain "hi" — no heuristic match, goalKind stays null.
    const plainChatId = generateId("chat");
    await chats.insert(pool, {
      id: plainChatId,
      workspaceId: wsId,
      agentId,
      title: "Plain",
    });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: plainChatId,
      role: "user",
      content: { type: "text", text: "hi" },
      kind: "chat",
    });

    const list = await chats.listWithLatestMessage(pool, wsId);
    expect(list.find((c) => c.id === dataChatId)?.goalKind).toBe("data");
    expect(list.find((c) => c.id === siteChatId)?.goalKind).toBe("site");
    expect(list.find((c) => c.id === plainChatId)?.goalKind).toBeNull();
  });

  it("goalKind: explicit chats.goal beats inferGoal()", async () => {
    // Chat is tagged 'document' on the column, but the message text would
    // infer 'app'. The column wins — that's the source of truth from
    // Task 3 onward.
    const explicitChatId = generateId("chat");
    await chats.insert(pool, {
      id: explicitChatId,
      workspaceId: wsId,
      agentId,
      title: "Explicit goal",
      goal: "document",
    });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: explicitChatId,
      role: "user",
      content: { type: "text", text: "build me an app" },
      kind: "chat",
    });

    const list = await chats.listWithLatestMessage(pool, wsId);
    expect(list.find((c) => c.id === explicitChatId)?.goalKind).toBe("document");
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
       VALUES (?, ?) ON CONFLICT DO NOTHING`,
      [wsId2, agentId],
    );
    const chatId2 = generateId("chat");
    await chats.insert(pool, { id: chatId2, workspaceId: wsId2, agentId, title: "Will be deleted" });

    await pool.query("DELETE FROM workspaces WHERE id = ?", [wsId2]);
    const chat = await chats.findById(pool, chatId2);
    expect(chat).toBeNull();
  });
});
