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
let workspaceId: string;
let agentId: string;

beforeAll(async () => {
  pool = await setupTestDb();
  const userId = generateId("user");
  await users.insert(pool, { id: userId, username: "msgowner", passwordHash: "h", email: "msg@example.com" });
  agentId = generateId("agent");
  await agents.insert(pool, { id: agentId, userId, name: "MsgAgent" });
  workspaceId = generateId("workspace");
  await workspaces.insert(pool, { id: workspaceId, userId, name: "MsgWS", path: `msgws-${workspaceId.slice(-6)}` });
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id)
     VALUES (?, ?) ON CONFLICT DO NOTHING`,
    [workspaceId, agentId],
  );
  chatId = generateId("chat");
  await chats.insert(pool, { id: chatId, workspaceId, agentId, title: "MsgChat" });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("messages queries", () => {
  it("inserts an agent message and marks chat unread", async () => {
    // Only agent-authored visible messages flip chats.unread — your own
    // sends aren't unread to you. See messages-writes.ts for the rule.
    await chats.markRead(pool, chatId);
    const msg = await messages.insert(pool, {
      id: generateId("message"),
      chatId,
      role: "agent",
      content: { type: "text", text: "Hello" },
    });
    expect(msg.chatId).toBe(chatId);
    expect(msg.role).toBe("agent");

    const chat = await chats.findById(pool, chatId);
    expect(chat!.unread).toBe(true);
    expect(chat!.updatedAt).toBe(msg.createdAt);
  });

  it("does not mark chat unread when the user sends a message", async () => {
    const userChatId = generateId("chat");
    await chats.insert(pool, { id: userChatId, workspaceId, agentId, title: "UserSend" });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: userChatId,
      role: "user",
      content: { type: "text", text: "I am the one sending" },
    });

    const chat = await chats.findById(pool, userChatId);
    expect(chat!.unread).toBe(false);
  });

  it("inserts summary messages without marking chat unread", async () => {
    const summaryChatId = generateId("chat");
    await chats.insert(pool, { id: summaryChatId, workspaceId, agentId, title: "Summary noise" });
    await messages.insert(pool, {
      id: generateId("message"),
      chatId: summaryChatId,
      role: "agent",
      content: { type: "summary", body: "# Summary\n\nCompacted context." },
      state: "succeeded",
      kind: "summary",
    });

    const chat = await chats.findById(pool, summaryChatId);
    expect(chat!.unread).toBe(false);
  });

  it("does not move chat updatedAt backwards when inserting a message", async () => {
    const monotonicChatId = generateId("chat");
    await chats.insert(pool, { id: monotonicChatId, workspaceId, agentId, title: "Monotonic" });
    const future = "2099-01-01T00:00:00.000Z";
    await pool.query("UPDATE chats SET updated_at = ?, unread = 0 WHERE id = ?", [future, monotonicChatId]);

    await messages.insert(pool, {
      id: generateId("message"),
      chatId: monotonicChatId,
      role: "agent",
      content: { type: "text", text: "Hello from the past" },
    });

    const chat = await chats.findById(pool, monotonicChatId);
    expect(chat!.updatedAt).toBe(future);
    expect(chat!.unread).toBe(true);
  });

  it("bumps a buried chat above the current newest chat when a visible message is inserted", async () => {
    const newestChatId = generateId("chat");
    const buriedChatId = generateId("chat");
    await chats.insert(pool, { id: newestChatId, workspaceId, agentId, title: "Newest" });
    await chats.insert(pool, { id: buriedChatId, workspaceId, agentId, title: "Buried" });
    const newest = "2099-01-01T00:00:00.000Z";
    const buried = "2026-01-01T00:00:00.000Z";
    await pool.query("UPDATE chats SET updated_at = ? WHERE id = ?", [newest, newestChatId]);
    await pool.query("UPDATE chats SET updated_at = ? WHERE id = ?", [buried, buriedChatId]);

    await messages.insert(pool, {
      id: generateId("message"),
      chatId: buriedChatId,
      role: "agent",
      content: { type: "text", text: "A new visible reply" },
    });

    const listed = await chats.listWithLatestMessage(pool, workspaceId);
    expect(listed[0]?.id).toBe(buriedChatId);
    expect(Date.parse(listed[0]!.updatedAt)).toBeGreaterThan(Date.parse(newest));
  });

  it("breaks updatedAt ties in favor of the chat receiving a visible message", async () => {
    const firstChatId = generateId("chat");
    const tiedChatId = generateId("chat");
    await chats.insert(pool, { id: firstChatId, workspaceId, agentId, title: "First tied" });
    await chats.insert(pool, { id: tiedChatId, workspaceId, agentId, title: "Second tied" });
    const tied = "2099-01-01T00:00:00.000Z";
    await pool.query("UPDATE chats SET updated_at = ? WHERE id IN (?, ?)", [tied, firstChatId, tiedChatId]);

    await messages.insert(pool, {
      id: generateId("message"),
      chatId: tiedChatId,
      role: "user",
      content: { type: "text", text: "Break the tie" },
    });

    const listed = await chats.listWithLatestMessage(pool, workspaceId);
    expect(listed[0]?.id).toBe(tiedChatId);
    expect(Date.parse(listed[0]!.updatedAt)).toBeGreaterThan(Date.parse(tied));
  });

  it("lists by chat with cursor pagination (forward)", async () => {
    // Insert a few more
    for (let i = 0; i < 3; i++) {
      await messages.insert(pool, {
        id: generateId("message"),
        chatId,
        role: "agent",
        content: { type: "text", text: `Reply ${i}` },
      });
    }

    // Forward pagination with explicit cursor: use the first message as cursor
    // to page forward from it.
    const allMsgs = await messages.listByChat(pool, chatId);
    expect(allMsgs.items.length).toBe(4); // 1 from prior test + 3 new

    const firstMsg = allMsgs.items[0];
    const cursor = `${firstMsg.createdAt}|${firstMsg.id}`;
    const page = await messages.listByChat(pool, chatId, { cursor, limit: 2 });
    expect(page.items).toHaveLength(2);
    // Messages after the first should be the next ones chronologically.
    expect(page.items[0].id).not.toBe(firstMsg.id);
  });

  it("lists by chat with reverse pagination (before)", async () => {
    // No-cursor call returns newest page. With 4 messages and limit=2,
    // we should get the 2 newest + a prevCursor.
    const newest = await messages.listByChat(pool, chatId, { limit: 2 });
    expect(newest.items).toHaveLength(2);
    expect(newest.prevCursor).toBeDefined();

    // Load older page using prevCursor.
    const older = await messages.listByChat(pool, chatId, { before: newest.prevCursor, limit: 2 });
    expect(older.items).toHaveLength(2);
    // Items returned in chronological order — oldest first.
    expect(new Date(older.items[0].createdAt).getTime())
      .toBeLessThanOrEqual(new Date(older.items[1].createdAt).getTime());
    // Older page items should come before newest page items chronologically.
    expect(new Date(older.items[1].createdAt).getTime())
      .toBeLessThanOrEqual(new Date(newest.items[0].createdAt).getTime());
  });

  it("cascades delete when chat is deleted", async () => {
    const { items } = await messages.listByChat(pool, chatId);
    expect(items.length).toBeGreaterThan(0);

    await pool.query("DELETE FROM chats WHERE id = ?", [chatId]);
    const result = await messages.listByChat(pool, chatId);
    expect(result.items).toHaveLength(0);
  });
});

describe("retargetAttachmentPaths", () => {
  let p: Pool;
  let wsId: string;
  let otherWsId: string;
  let cId: string;
  let otherWsCId: string;

  beforeAll(async () => {
    p = await setupTestDb();
    const userId = generateId("user");
    await users.insert(p, { id: userId, username: "rt", passwordHash: "h", email: "rt@example.com" });
    const agentId = generateId("agent");
    await agents.insert(p, { id: agentId, userId, name: "RtAgent" });
    wsId = generateId("workspace");
    otherWsId = generateId("workspace");
    await workspaces.insert(p, { id: wsId, userId, name: "WS", path: `ws-${wsId.slice(-6)}` });
    await workspaces.insert(p, { id: otherWsId, userId, name: "Other", path: `other-${otherWsId.slice(-6)}` });
    for (const w of [wsId, otherWsId]) {
      await p.query(
        `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
        [w, agentId],
      );
    }
    cId = generateId("chat");
    otherWsCId = generateId("chat");
    await chats.insert(p, { id: cId, workspaceId: wsId, agentId, title: "Chat" });
    await chats.insert(p, { id: otherWsCId, workspaceId: otherWsId, agentId, title: "OtherChat" });
  });

  afterAll(async () => {
    await teardownTestDb(p);
  });

  it("rewrites exact-match attachment paths after a file rename", async () => {
    const m = await messages.insert(p, {
      id: generateId("message"),
      chatId: cId,
      role: "user",
      content: { type: "text", text: "see attached" },
      attachments: [{ path: "Projects/Report.pdf", name: "Report.pdf", mime: "application/pdf" }],
    });

    const updated = await messages.retargetAttachmentPaths(
      p,
      wsId,
      "Projects/Report.pdf",
      "Projects/Q2-Report.pdf",
    );
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe(m.id);
    expect(updated[0].attachments?.[0].path).toBe("Projects/Q2-Report.pdf");
    // Name follows the new basename so the message-bubble chip's title
    // and subtext stay aligned (the chip renders both).
    expect(updated[0].attachments?.[0].name).toBe("Q2-Report.pdf");
  });

  it("rewrites descendant paths after a folder rename and the folder ref itself", async () => {
    const child = await messages.insert(p, {
      id: generateId("message"),
      chatId: cId,
      role: "user",
      content: { type: "text", text: "deep" },
      attachments: [{ path: "Old/Inner/file.txt", name: "file.txt" }],
    });
    const folderRef = await messages.insert(p, {
      id: generateId("message"),
      chatId: cId,
      role: "user",
      content: { type: "text", text: "the folder" },
      attachments: [{ path: "Old", name: "Old", kind: "directory" }],
    });

    const updated = await messages.retargetAttachmentPaths(p, wsId, "Old", "New");
    const ids = updated.map((m) => m.id).sort();
    expect(ids).toEqual([child.id, folderRef.id].sort());
    const childUpd = updated.find((m) => m.id === child.id)!;
    const folderUpd = updated.find((m) => m.id === folderRef.id)!;
    expect(childUpd.attachments?.[0].path).toBe("New/Inner/file.txt");
    expect(folderUpd.attachments?.[0].path).toBe("New");
  });

  it("leaves unrelated attachments untouched", async () => {
    const sibling = await messages.insert(p, {
      id: generateId("message"),
      chatId: cId,
      role: "user",
      content: { type: "text", text: "unrelated" },
      attachments: [{ path: "Other/keep.txt", name: "keep.txt" }],
    });
    // Path that is a *prefix* of the renamed path but not the same dir —
    // `Other` shouldn't match `Othe`.
    const lookalike = await messages.insert(p, {
      id: generateId("message"),
      chatId: cId,
      role: "user",
      content: { type: "text", text: "lookalike" },
      attachments: [{ path: "Othersuffix/x.txt", name: "x.txt" }],
    });

    const updated = await messages.retargetAttachmentPaths(p, wsId, "Other", "Renamed");
    const ids = updated.map((m) => m.id);
    expect(ids).not.toContain(lookalike.id);
    // `Other/keep.txt` is under `Other/`, so it *should* update.
    expect(ids).toContain(sibling.id);
  });

  it("scopes the rewrite to the given workspace", async () => {
    const sameName = await messages.insert(p, {
      id: generateId("message"),
      chatId: otherWsCId,
      role: "user",
      content: { type: "text", text: "other ws" },
      attachments: [{ path: "Shared/name.txt", name: "name.txt" }],
    });
    const inWs = await messages.insert(p, {
      id: generateId("message"),
      chatId: cId,
      role: "user",
      content: { type: "text", text: "in ws" },
      attachments: [{ path: "Shared/name.txt", name: "name.txt" }],
    });

    const updated = await messages.retargetAttachmentPaths(
      p,
      wsId,
      "Shared/name.txt",
      "Shared/renamed.txt",
    );
    const ids = updated.map((m) => m.id);
    expect(ids).toEqual([inWs.id]);
    // Confirm the other-workspace row is untouched.
    const stillStale = await messages.findById(p, sameName.id);
    expect(stillStale?.attachments?.[0].path).toBe("Shared/name.txt");
  });

  it("ignores messages with no attachments", async () => {
    await messages.insert(p, {
      id: generateId("message"),
      chatId: cId,
      role: "user",
      content: { type: "text", text: "no attachments" },
    });
     // No throw, no spurious updates.
    const updated = await messages.retargetAttachmentPaths(
      p,
      wsId,
      "Nonexistent/path.txt",
      "Other/path.txt",
    );
    expect(updated).toHaveLength(0);
  });
});

describe("recoverOrphanedRuns", () => {
  let p: Pool;
  let cId: string;

  beforeAll(async () => {
    p = await setupTestDb();
    const userId = generateId("user");
    await users.insert(p, { id: userId, username: "orphan-user", passwordHash: "h", email: "orphan@example.com" });
    const agentId = generateId("agent");
    await agents.insert(p, { id: agentId, userId, name: "OrphanAgent" });
    const wsId = generateId("workspace");
    await workspaces.insert(p, { id: wsId, userId, name: "OrphanWS", path: `orphanws-${wsId.slice(-6)}` });
    await p.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id)
       VALUES (?, ?) ON CONFLICT DO NOTHING`,
      [wsId, agentId],
    );
    cId = generateId("chat");
    await chats.insert(p, { id: cId, workspaceId: wsId, agentId, title: "OrphanChat" });
  });

  afterAll(async () => {
    await teardownTestDb(p);
  });

  it("re-queues orphaned running agent_turn messages as pending", async () => {
    const id = generateId("message");
    await messages.insert(p, {
      id,
      chatId: cId,
      role: "system",
      content: { type: "agent_turn", userMessageId: "fake" },
      state: "running",
    });
    const result = await messages.recoverOrphanedRuns(p);
    expect(result.requeued).toContain(id);
    const msg = await messages.findById(p, id);
    expect(msg!.state).toBe("pending");
    expect(msg!.executeAt).toBeTruthy();
    expect(msg!.startedAt).toBeUndefined();
    expect(msg!.endedAt).toBeUndefined();
  });

  it("re-queues orphaned pending agent_turn (no execute_at) as pending with execute_at", async () => {
    const id = generateId("message");
    await messages.insert(p, {
      id,
      chatId: cId,
      role: "system",
      content: { type: "agent_turn", userMessageId: "fake2" },
      state: "pending",
    });
    const result = await messages.recoverOrphanedRuns(p);
    expect(result.requeued).toContain(id);
    const msg = await messages.findById(p, id);
    expect(msg!.state).toBe("pending");
    expect(msg!.executeAt).toBeTruthy();
  });

  it("re-queues orphaned running summary_request messages as pending", async () => {
    const id = generateId("message");
    await messages.insert(p, {
      id,
      chatId: cId,
      role: "system",
      content: { type: "summary_request" },
      state: "running",
    });
    const result = await messages.recoverOrphanedRuns(p);
    expect(result.requeued).toContain(id);
    const msg = await messages.findById(p, id);
    expect(msg!.state).toBe("pending");
  });

  it("fails orphaned task_run messages and resets the parent task off 'running'", async () => {
    // Reproduces the "stuck in Active" bug: an agent-authored unscheduled
    // task gets promoted to state='running' on auto-fire (see
    // dispatch/sandbox.ts and runs.ts:fireMessage). If the server dies
    // before afterTaskRun mirrors the terminal state, the child task_run
    // is recovered as 'failed' but the parent stays 'running' forever,
    // which the status selector reads as Active on every list.
    const taskId = generateId("message");
    await messages.insert(p, {
      id: taskId,
      chatId: cId,
      role: "user",
      content: { type: "text", text: "a task" },
      kind: "task",
      state: "running",
    });
    const runId = generateId("message");
    await p.query(
      `INSERT INTO messages (id, chat_id, role, content, kind, state, parent_id)
       VALUES (?, ?, 'user', '{"type":"text","text":"run"}', 'task_run', 'running', ?)`,
      [runId, cId, taskId],
    );
    const result = await messages.recoverOrphanedRuns(p);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const run = await messages.findById(p, runId);
    expect(run!.state).toBe("failed");
    const parent = await messages.findById(p, taskId);
    expect(parent!.state).toBe("pending");
    expect(parent!.startedAt).toBeUndefined();
    expect(parent!.endedAt).toBeUndefined();
  });

  it("resets a parent task stuck in 'running' even with no child task_run row", async () => {
    // Covers the gap where the run row was never written (e.g. crash
    // between updateMessageIfState promote-to-running and beginTaskRun)
    // but the parent did get promoted. The previous orphan sweep only
    // looked at task_run/agent_turn rows, so this parent was invisible.
    const taskId = generateId("message");
    await messages.insert(p, {
      id: taskId,
      chatId: cId,
      role: "user",
      content: { type: "text", text: "orphan parent only" },
      kind: "task",
      state: "running",
    });
    await messages.recoverOrphanedRuns(p);
    const parent = await messages.findById(p, taskId);
    expect(parent!.state).toBe("pending");
  });

  it("leaves pending tasks alone — they're legitimate scheduled work, not orphans", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const taskId = generateId("message");
    await messages.insert(p, {
      id: taskId,
      chatId: cId,
      role: "user",
      content: { type: "text", text: "scheduled" },
      kind: "task",
      state: "pending",
      executeAt: future,
    });
    await messages.recoverOrphanedRuns(p);
    const parent = await messages.findById(p, taskId);
    expect(parent!.state).toBe("pending");
    expect(parent!.executeAt).toBe(future);
  });

  it("leaves terminal-state tasks alone", async () => {
    const taskId = generateId("message");
    await messages.insert(p, {
      id: taskId,
      chatId: cId,
      role: "user",
      content: { type: "text", text: "done task" },
      kind: "task",
      state: "succeeded",
    });
    await messages.recoverOrphanedRuns(p);
    const parent = await messages.findById(p, taskId);
    expect(parent!.state).toBe("succeeded");
  });

  it("leaves scheduled pending messages alone (future execute_at)", async () => {
    const id = generateId("message");
    const future = new Date(Date.now() + 3600_000).toISOString();
    await messages.insert(p, {
      id,
      chatId: cId,
      role: "system",
      content: { type: "summary_request" },
      state: "pending",
      executeAt: future,
    });
    await messages.recoverOrphanedRuns(p);
    const msg = await messages.findById(p, id);
    expect(msg!.state).toBe("pending");
  });

  it("does not touch succeeded or failed messages", async () => {
    const id = generateId("message");
    await messages.insert(p, {
      id,
      chatId: cId,
      role: "system",
      content: { type: "agent_turn", userMessageId: "fake3" },
      state: "succeeded",
    });
    await messages.recoverOrphanedRuns(p);
    const msg = await messages.findById(p, id);
    expect(msg!.state).toBe("succeeded");
  });

  it("does not touch regular text messages in pending state", async () => {
    const id = generateId("message");
    await messages.insert(p, {
      id,
      chatId: cId,
      role: "user",
      content: { type: "text", text: "hello" },
      state: "pending",
    });
    await messages.recoverOrphanedRuns(p);
    const msg = await messages.findById(p, id);
    expect(msg!.state).toBe("pending");
  });
});
