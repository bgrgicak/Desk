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

  it("kind picks the newest user-action kind; chat and summary are fallbacks", async () => {
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

    // Chat D: task plus a later summary — summary is auto-emitted by the
    // scheduler on every turn, so it must NOT hijack the icon. kind stays
    // 'task'.
    const chatD = generateId("chat");
    await chats.insert(pool, { id: chatD, workspaceId: wsId, agentId, title: "Task + summary" });
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
      content: { type: "summary_request" },
      kind: "summary",
    });

    // Chat E: only chat + summary → both are fallbacks → 'chat'.
    const chatE = generateId("chat");
    await chats.insert(pool, { id: chatE, workspaceId: wsId, agentId, title: "Chat + summary" });
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
      content: { type: "summary_request" },
      kind: "summary",
    });

    const list = await chats.listWithLatestMessage(pool, wsId);
    expect(list.find((c) => c.id === chatA)?.kind).toBe("task");
    expect(list.find((c) => c.id === chatB)?.kind).toBe("task");
    expect(list.find((c) => c.id === chatC)?.kind).toBe("chat");
    expect(list.find((c) => c.id === chatD)?.kind).toBe("task");
    expect(list.find((c) => c.id === chatE)?.kind).toBe("chat");
  });

  it("list exposes only the persisted chat goal", async () => {
    // Message text would match the data heuristic, but list reads the single
    // persisted goal source from chats.goal instead of computing a second tag.
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
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: dataChatId,
      role: "system",
      content: { type: "summary_request" },
      kind: "summary",
    });

    const list = await chats.listWithLatestMessage(pool, wsId);
    const dataChat = list.find((c) => c.id === dataChatId);
    expect(dataChat?.goal).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(dataChat, "goalKind")).toBe(false);
  });

  it("list returns explicit chats.goal", async () => {
    // Chat is tagged 'document' on the column, but the message text would
    // infer 'app'. The column is the only list-time source of truth.
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
    expect(list.find((c) => c.id === explicitChatId)?.goal).toBe("document");
  });

  it("rejects invalid chat goals", async () => {
    await expect(chats.insert(pool, {
      id: generateId("chat"),
      workspaceId: wsId,
      agentId,
      title: "Invalid goal",
      goal: "not-a-goal",
    })).rejects.toThrow(/Invalid chat goal/);

    await expect(chats.updateMeta(pool, chatId, { goal: "not-a-goal" }))
      .rejects.toThrow(/Invalid chat goal/);
  });

  it("clears a persisted chat goal when goal is null", async () => {
    await chats.updateMeta(pool, chatId, { goal: "document" });
    const cleared = await chats.updateMeta(pool, chatId, { goal: null });
    expect(cleared?.goal).toBeUndefined();
  });

  it("running is true when a message has pending or running state", async () => {
    const runningChatId = generateId("chat");
    await chats.insert(pool, { id: runningChatId, workspaceId: wsId, agentId, title: "Running chat" });
    // Insert a user message (no state) and an agent_turn in 'running' state
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: runningChatId,
      role: "user",
      content: { type: "text", text: "do something" },
      kind: "chat",
    });
    const agentTurnId = generateId("message");
    await messages.insert(pool, {
      id: agentTurnId,
      chatId: runningChatId,
      role: "agent",
      content: { type: "agent_turn", userMessageId: "ignored" },
      kind: "chat",
      state: "running",
    });

    const list = await chats.listWithLatestMessage(pool, wsId);
    expect(list.find((c) => c.id === runningChatId)?.running).toBe(true);

    // Transition to succeeded — running should become false
    await pool.query("UPDATE messages SET state = 'succeeded' WHERE id = ?", [agentTurnId]);
    const list2 = await chats.listWithLatestMessage(pool, wsId);
    expect(list2.find((c) => c.id === runningChatId)?.running).toBe(false);
  });

  it("failed is true only when the latest agent_turn failed", async () => {
    const failedChatId = generateId("chat");
    await chats.insert(pool, { id: failedChatId, workspaceId: wsId, agentId, title: "Failed chat" });
    const agentTurnId = generateId("message");
    await messages.insert(pool, {
      id: agentTurnId,
      chatId: failedChatId,
      role: "system",
      content: { type: "agent_turn", userMessageId: "user-message" },
      kind: "chat",
      state: "failed",
    });

    const list = await chats.listWithLatestMessage(pool, wsId);
    expect(list.find((c) => c.id === failedChatId)?.failed).toBe(true);

    await pool.query("UPDATE messages SET state = 'running' WHERE id = ?", [agentTurnId]);
    const retryingList = await chats.listWithLatestMessage(pool, wsId);
    expect(retryingList.find((c) => c.id === failedChatId)?.failed).toBe(false);

    await pool.query("UPDATE messages SET state = 'succeeded' WHERE id = ?", [agentTurnId]);
    const succeededList = await chats.listWithLatestMessage(pool, wsId);
    expect(succeededList.find((c) => c.id === failedChatId)?.failed).toBe(false);
  });

  it("uses insertion order when agent_turn timestamps tie", async () => {
    const retryChatId = generateId("chat");
    await chats.insert(pool, { id: retryChatId, workspaceId: wsId, agentId, title: "Retry chat" });
    const tiedCreatedAt = "2026-01-01T00:00:00.000Z";
    // The older failed message has a lexically larger id than the newer
    // running retry. If the trigger breaks timestamp ties by id, this chat
    // incorrectly keeps showing the red failure dot instead of the loader.
    await messages.insert(pool, {
      id: "message_zz_old_failed",
      chatId: retryChatId,
      role: "system",
      content: { type: "agent_turn", userMessageId: "old" },
      kind: "chat",
      state: "failed",
    });
    await messages.insert(pool, {
      id: "message_aa_new_running",
      chatId: retryChatId,
      role: "system",
      content: { type: "agent_turn", userMessageId: "new" },
      kind: "chat",
      state: "running",
    });
    await pool.query("UPDATE messages SET created_at = ? WHERE chat_id = ?", [tiedCreatedAt, retryChatId]);

    const list = await chats.listWithLatestMessage(pool, wsId);
    const retryChat = list.find((c) => c.id === retryChatId);
    expect(retryChat?.running).toBe(true);
    expect(retryChat?.failed).toBe(false);
  });

  it("running ignores non-agent_turn messages in pending/running state", async () => {
    const taskChatId = generateId("chat");
    await chats.insert(pool, { id: taskChatId, workspaceId: wsId, agentId, title: "Task chat" });
    // Insert a task message in 'running' state (kanban signal) — should NOT
    // make the chat appear as running in the sidebar spinner sense.
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: taskChatId,
      role: "user",
      content: { type: "text", text: "a task" },
      kind: "task",
      state: "running",
    });
    // Also insert a summary_request in 'pending' — also should not count.
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: taskChatId,
      role: "system",
      content: { type: "summary_request" },
      kind: "summary",
      state: "pending",
    });

    const list = await chats.listWithLatestMessage(pool, wsId);
    expect(list.find((c) => c.id === taskChatId)?.running).toBe(false);
  });

  it("running checks only the latest agent_turn, ignoring orphaned older ones", async () => {
    const orphanChatId = generateId("chat");
    await chats.insert(pool, { id: orphanChatId, workspaceId: wsId, agentId, title: "Orphan chat" });
    // Old agent_turn stuck in 'pending' (e.g. from crash recovery re-queue)
    const oldAgentTurnId = generateId("message");
    await messages.insert(pool, {
      id: oldAgentTurnId,
      chatId: orphanChatId,
      role: "system",
      content: { type: "agent_turn", userMessageId: "old" },
      kind: "chat",
      state: "pending",
    });
    // Newer agent_turn that already succeeded
    const newAgentTurnId = generateId("message");
    await messages.insert(pool, {
      id: newAgentTurnId,
      chatId: orphanChatId,
      role: "system",
      content: { type: "agent_turn", userMessageId: "new" },
      kind: "chat",
      state: "succeeded",
    });
    // Give the two rows deterministic timestamps: inserts can occur inside
    // the same millisecond in SQLite, and the chat-list cache trigger orders
    // by (created_at, id) to match message pagination.
    await pool.query("UPDATE messages SET created_at = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", oldAgentTurnId]);
    await pool.query("UPDATE messages SET created_at = ? WHERE id = ?", ["2026-01-01T00:00:01.000Z", newAgentTurnId]);

    const list = await chats.listWithLatestMessage(pool, wsId);
    // The latest agent_turn succeeded, so the chat should NOT show as running
    // even though an older orphaned agent_turn is still in 'pending'.
    expect(list.find((c) => c.id === orphanChatId)?.running).toBe(false);
  });

  it("running is false when no messages have pending/running state", async () => {
    const idleChatId = generateId("chat");
    await chats.insert(pool, { id: idleChatId, workspaceId: wsId, agentId, title: "Idle chat" });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: idleChatId,
      role: "user",
      content: { type: "text", text: "just chatting" },
      kind: "chat",
    });

    const list = await chats.listWithLatestMessage(pool, wsId);
    expect(list.find((c) => c.id === idleChatId)?.running).toBe(false);
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

  it("clearOpencodeSessionsForAgent: nulls every chat using the agent and reports them", async () => {
    const userIdLocal = generateId("user");
    await users.insert(pool, { id: userIdLocal, username: "clearagentowner", passwordHash: "h", email: "clear@example.com" });
    const aId = generateId("agent");
    await agents.insert(pool, { id: aId, userId: userIdLocal, name: "ClearAgent", model: "anthropic/x" });
    const wsLocal = generateId("workspace");
    await workspaces.insert(pool, { id: wsLocal, userId: userIdLocal, name: "ClearWS", path: `clearws-${wsLocal.slice(-6)}` });
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
      [wsLocal, aId],
    );

    const c1 = generateId("chat");
    const c2 = generateId("chat");
    const c3 = generateId("chat");
    await chats.insert(pool, { id: c1, workspaceId: wsLocal, agentId: aId, title: "c1" });
    await chats.insert(pool, { id: c2, workspaceId: wsLocal, agentId: aId, title: "c2" });
    await chats.insert(pool, { id: c3, workspaceId: wsLocal, agentId: aId, title: "c3" });
    await chats.setOpencodeSessionId(pool, c1, "ses_first");
    await chats.setOpencodeSessionId(pool, c2, "ses_second");
    // c3 left null on purpose — the helper must skip it.

    const cleared = await chats.clearOpencodeSessionsForAgent(pool, aId);
    expect(cleared.map((r) => r.chatId).sort()).toEqual([c1, c2].sort());
    expect(cleared.find((r) => r.chatId === c1)?.previousSessionId).toBe("ses_first");
    expect(cleared.find((r) => r.chatId === c2)?.previousSessionId).toBe("ses_second");

    expect(await chats.getOpencodeSessionId(pool, c1)).toBeNull();
    expect(await chats.getOpencodeSessionId(pool, c2)).toBeNull();
    expect(await chats.getOpencodeSessionId(pool, c3)).toBeNull();
  });

  it("clearOpencodeSessionsForAgent: returns empty array when nothing to clear", async () => {
    const userIdLocal = generateId("user");
    await users.insert(pool, { id: userIdLocal, username: "noopclear", passwordHash: "h", email: "noop@example.com" });
    const aId = generateId("agent");
    await agents.insert(pool, { id: aId, userId: userIdLocal, name: "NoopAgent" });
    const cleared = await chats.clearOpencodeSessionsForAgent(pool, aId);
    expect(cleared).toEqual([]);
  });

  it("clearOpencodeSessionsForUser: nulls every session across the user's chats and reports them", async () => {
    const userA = generateId("user");
    const userB = generateId("user");
    await users.insert(pool, { id: userA, username: "userA-clear", passwordHash: "h", email: "a@example.com" });
    await users.insert(pool, { id: userB, username: "userB-clear", passwordHash: "h", email: "b@example.com" });
    const aA = generateId("agent");
    const aB = generateId("agent");
    await agents.insert(pool, { id: aA, userId: userA, name: "agentA" });
    await agents.insert(pool, { id: aB, userId: userB, name: "agentB" });
    const wsA1 = generateId("workspace");
    const wsA2 = generateId("workspace");
    const wsB = generateId("workspace");
    await workspaces.insert(pool, { id: wsA1, userId: userA, name: "wsA1", path: `wsa1-${wsA1.slice(-6)}` });
    await workspaces.insert(pool, { id: wsA2, userId: userA, name: "wsA2", path: `wsa2-${wsA2.slice(-6)}` });
    await workspaces.insert(pool, { id: wsB, userId: userB, name: "wsB", path: `wsb-${wsB.slice(-6)}` });
    for (const [ws, ag] of [[wsA1, aA], [wsA2, aA], [wsB, aB]] as const) {
      await pool.query(
        `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
        [ws, ag],
      );
    }
    const c1 = generateId("chat");
    const c2 = generateId("chat");
    const c3 = generateId("chat");
    const c4 = generateId("chat");
    await chats.insert(pool, { id: c1, workspaceId: wsA1, agentId: aA, title: "userA c1" });
    await chats.insert(pool, { id: c2, workspaceId: wsA2, agentId: aA, title: "userA c2" });
    await chats.insert(pool, { id: c3, workspaceId: wsA1, agentId: aA, title: "userA c3 no session" });
    await chats.insert(pool, { id: c4, workspaceId: wsB, agentId: aB, title: "userB c4" });
    await chats.setOpencodeSessionId(pool, c1, "ses_a1");
    await chats.setOpencodeSessionId(pool, c2, "ses_a2");
    await chats.setOpencodeSessionId(pool, c4, "ses_b1");

    const cleared = await chats.clearOpencodeSessionsForUser(pool, userA);
    expect(cleared.map((r) => r.chatId).sort()).toEqual([c1, c2].sort());
    expect(await chats.getOpencodeSessionId(pool, c1)).toBeNull();
    expect(await chats.getOpencodeSessionId(pool, c2)).toBeNull();
    // Other user's session is untouched.
    expect(await chats.getOpencodeSessionId(pool, c4)).toBe("ses_b1");
  });

  it("clearOpencodeSessionsForUser: workspaceId scopes the clear to one workspace", async () => {
    const userId2 = generateId("user");
    await users.insert(pool, { id: userId2, username: "user-ws-scope", passwordHash: "h", email: "ws@example.com" });
    const aId = generateId("agent");
    await agents.insert(pool, { id: aId, userId: userId2, name: "wsScopeAgent" });
    const wsKeep = generateId("workspace");
    const wsClear = generateId("workspace");
    await workspaces.insert(pool, { id: wsKeep, userId: userId2, name: "keep", path: `keep-${wsKeep.slice(-6)}` });
    await workspaces.insert(pool, { id: wsClear, userId: userId2, name: "clear", path: `clear-${wsClear.slice(-6)}` });
    for (const ws of [wsKeep, wsClear]) {
      await pool.query(
        `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
        [ws, aId],
      );
    }
    const cKeep = generateId("chat");
    const cClear = generateId("chat");
    await chats.insert(pool, { id: cKeep, workspaceId: wsKeep, agentId: aId, title: "keep" });
    await chats.insert(pool, { id: cClear, workspaceId: wsClear, agentId: aId, title: "clear" });
    await chats.setOpencodeSessionId(pool, cKeep, "ses_keep");
    await chats.setOpencodeSessionId(pool, cClear, "ses_clear");

    const cleared = await chats.clearOpencodeSessionsForUser(pool, userId2, wsClear);
    expect(cleared.map((r) => r.chatId)).toEqual([cClear]);
    expect(await chats.getOpencodeSessionId(pool, cKeep)).toBe("ses_keep");
    expect(await chats.getOpencodeSessionId(pool, cClear)).toBeNull();
  });

  it("clearOpencodeSessionsForUser: returns empty array when nothing to clear", async () => {
    const u = generateId("user");
    await users.insert(pool, { id: u, username: "noop-user-clear", passwordHash: "h", email: "noopu@example.com" });
    const cleared = await chats.clearOpencodeSessionsForUser(pool, u);
    expect(cleared).toEqual([]);
  });

  it("updateMeta: atomically clears opencode_session_id when agentId changes", async () => {
    // Make a fresh user/agents/workspace/chat so we don't bleed state into
    // the shared chatId/agentId fixtures above.
    const userIdLocal = generateId("user");
    await users.insert(pool, { id: userIdLocal, username: "swap-agent", passwordHash: "h", email: "swap@example.com" });
    const wsLocal = generateId("workspace");
    await workspaces.insert(pool, { id: wsLocal, userId: userIdLocal, name: "swap", path: `swap-${wsLocal.slice(-6)}` });
    const aOld = generateId("agent");
    const aNew = generateId("agent");
    await agents.insert(pool, { id: aOld, userId: userIdLocal, name: "old", model: "openai/gpt-5.4" });
    await agents.insert(pool, { id: aNew, userId: userIdLocal, name: "new", model: "anthropic/claude-3.5-sonnet" });
    for (const ag of [aOld, aNew]) {
      await pool.query(
        `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
        [wsLocal, ag],
      );
    }
    const cId = generateId("chat");
    await chats.insert(pool, { id: cId, workspaceId: wsLocal, agentId: aOld, title: "swap me" });
    await chats.setOpencodeSessionId(pool, cId, "ses_bound_to_old");

    const updated = await chats.updateMeta(pool, cId, { agentId: aNew });
    expect(updated?.agentId).toBe(aNew);
    // The session-id clear is part of the same UPDATE — read it back
    // to confirm it landed atomically with the agent swap.
    expect(await chats.getOpencodeSessionId(pool, cId)).toBeNull();
  });

  it("updateMeta: leaves opencode_session_id alone when only unrelated fields change", async () => {
    const userIdLocal = generateId("user");
    await users.insert(pool, { id: userIdLocal, username: "title-only", passwordHash: "h", email: "title@example.com" });
    const wsLocal = generateId("workspace");
    await workspaces.insert(pool, { id: wsLocal, userId: userIdLocal, name: "titlews", path: `titlews-${wsLocal.slice(-6)}` });
    const ag = generateId("agent");
    await agents.insert(pool, { id: ag, userId: userIdLocal, name: "ag" });
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
      [wsLocal, ag],
    );
    const cId = generateId("chat");
    await chats.insert(pool, { id: cId, workspaceId: wsLocal, agentId: ag, title: "before" });
    await chats.setOpencodeSessionId(pool, cId, "ses_keepme");

    await chats.updateMeta(pool, cId, { title: "after" });
    expect(await chats.getOpencodeSessionId(pool, cId)).toBe("ses_keepme");
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
