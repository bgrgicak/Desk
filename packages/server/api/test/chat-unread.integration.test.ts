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
 * 6. End-to-end summary fire does not flip unread or bump updated_at
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations, queries, hashPassword } from "@agent-desk/db";
import { ensureLayout, type StorageContext } from "@agent-desk/storage";
import { generateId, type WsEvent } from "@agent-desk/shared";
import { createRunManager } from "@agent-desk/scheduler";
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

  it("markRead returns the full chat atomically with unread=false", async () => {
    const chatId = await freshChat();
    await sendMessage(pool, chatId, { content: "hello" }, () => {});
    expect((await queries.chats.findById(pool, chatId))!.unread).toBe(true);

    // markRead should return the full Chat with unread=false in a single
    // atomic RETURNING * query.
    const result = await queries.chats.markRead(pool, chatId);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(chatId);
    expect(result!.unread).toBe(false);
  });

  it("markRead returns null for a missing chat", async () => {
    const result = await queries.chats.markRead(pool, "nonexistent");
    expect(result).toBeNull();
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

  it("inserting an agent_turn message does not set unread or bump updated_at", async () => {
    const chatId = await freshChat();
    const before = await queries.chats.findById(pool, chatId);
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId,
      role: "system",
      content: { type: "agent_turn", userMessageId: "msg_placeholder" },
      state: "pending",
    });
    const after = await queries.chats.findById(pool, chatId);
    expect(after!.unread).toBe(false);
    expect(after!.updatedAt).toBe(before!.updatedAt);
  });

  it("inserting a summary_request message does not set unread or bump updated_at", async () => {
    const chatId = await freshChat();
    const before = await queries.chats.findById(pool, chatId);
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId,
      role: "system",
      content: { type: "summary_request" },
      state: "pending",
      kind: "summary",
    });
    const after = await queries.chats.findById(pool, chatId);
    expect(after!.unread).toBe(false);
    expect(after!.updatedAt).toBe(before!.updatedAt);
  });

  it("inserting a summary message does not set unread or bump updated_at", async () => {
    const chatId = await freshChat();
    const before = await queries.chats.findById(pool, chatId);
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId,
      role: "agent",
      content: { type: "summary", body: "# Chat Summary\nThis is a test." },
    });
    const after = await queries.chats.findById(pool, chatId);
    expect(after!.unread).toBe(false);
    expect(after!.updatedAt).toBe(before!.updatedAt);
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

  it("inserting an artifactRef message does not set unread or bump updated_at", async () => {
    const chatId = await freshChat();
    const before = await queries.chats.findById(pool, chatId);
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId,
      role: "agent",
      content: { type: "artifactRef", path: "artifacts/test.md", name: "test.md" },
    });
    const after = await queries.chats.findById(pool, chatId);
    expect(after!.unread).toBe(false);
    expect(after!.updatedAt).toBe(before!.updatedAt);
  });

  it("inserting a message with kind='summary' does not set unread regardless of content type", async () => {
    const chatId = await freshChat();
    const before = await queries.chats.findById(pool, chatId);
    // Failed summary runs produce events content with kind="summary"
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId,
      role: "agent",
      content: { type: "events", log: [] },
      kind: "summary",
    });
    const after = await queries.chats.findById(pool, chatId);
    expect(after!.unread).toBe(false);
    expect(after!.updatedAt).toBe(before!.updatedAt);
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

  // ── Chat list stays lean: no unused lastMessageContent projection ───────────

  it("listWithLatestMessage omits unused lastMessageContent", async () => {
    const chatId = await freshChat();
    await sendMessage(pool, chatId, { content: "hello from user" }, () => {});
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId,
      role: "agent",
      content: { type: "summary", body: "# Summary" },
    });

    const list = await queries.chats.listWithLatestMessage(pool, workspaceId);
    const found = list.find((c) => c.id === chatId);
    expect(found).toBeDefined();
    // The app never rendered this field, so /chats no longer pays the SQL,
    // JSON extraction, or response-size cost to include it.
    expect(Object.prototype.hasOwnProperty.call(found!, "lastMessageContent")).toBe(false);
  });

  // ── End-to-end: firing a summary through the run manager ───────────────────

  it("firing a summary_request via run manager does NOT flip unread or bump updated_at", async () => {
    const chatId = await freshChat();
    // Record the baseline state.
    const baseline = await queries.chats.findById(pool, chatId);

    // Collect all WS events emitted during the fire.
    const events: WsEvent[] = [];
    const rm = createRunManager({
      pool,
      emit: (e) => events.push(e),
      execRunFn: async (runId, _a, _p, onLog) => {
        onLog({ runId, seq: 0, kind: "stdout", payload: '{"type":"text","part":{"text":"# Summary\\nTest."}}' });
        return { exitCode: 0 };
      },
    });

    // Insert a summary_request the same way scheduleSummary does.
    const reqId = generateId("message");
    await queries.messages.insert(pool, {
      id: reqId,
      chatId,
      role: "system",
      content: { type: "summary_request" },
      state: "pending",
      kind: "summary",
      executeAt: new Date().toISOString(),
    });

    // Fire the summary.
    const { fired, childIds } = await rm.fireMessage(reqId);
    expect(fired).toBe(true);
    expect(childIds.length).toBe(1);

    // The chat's unread and updated_at should not have changed.
    const after = await queries.chats.findById(pool, chatId);
    expect(after!.unread).toBe(false);
    expect(after!.updatedAt).toBe(baseline!.updatedAt);

    // Verify the child message is type=summary with kind=summary.
    const child = await queries.messages.findById(pool, childIds[0]);
    expect(child!.content.type).toBe("summary");
    expect(child!.kind).toBe("summary");

    // Verify no emitted message.appended event has a non-internal content
    // type (which would trigger Chat tag invalidation on the client).
    const appendedEvents = events.filter((e) => e.type === "message.appended");
    for (const evt of appendedEvents) {
      const msg = evt.payload as { content?: { type?: string }; kind?: string };
      const ct = msg.content?.type;
      const mk = msg.kind ?? "chat";
      const isInternal =
        ct === "agent_turn" ||
        ct === "summary_request" ||
        ct === "summary" ||
        ct === "artifactRef" ||
        mk === "summary";
      expect(isInternal).toBe(true);
    }
  });

  it("firing a regular agent_turn via run manager sets unread but summary afterwards does NOT", async () => {
    const chatId = await freshChat();
    const events: WsEvent[] = [];
    const rm = createRunManager({
      pool,
      emit: (e) => events.push(e),
      execRunFn: async (runId, _a, _p, onLog) => {
        onLog({ runId, seq: 0, kind: "stdout", payload: '{"type":"text","part":{"text":"Hello!"}}' });
        return { exitCode: 0 };
      },
    });

    // Send a regular chat message which creates an agent_turn trigger.
    const { triggerId } = await sendMessage(pool, chatId, { content: "hi" }, (e) => events.push(e));

    // The user text message sets unread=1.
    expect((await queries.chats.findById(pool, chatId))!.unread).toBe(true);

    // Mark read (simulating the user viewing the chat).
    await patchChat(pool, chatId, { unread: false });
    expect((await queries.chats.findById(pool, chatId))!.unread).toBe(false);

    // Fire the agent_turn — produces an events output child.
    await rm.fireMessage(triggerId);

    // The events output child IS visible → should set unread=1.
    expect((await queries.chats.findById(pool, chatId))!.unread).toBe(true);

    // Mark read again.
    await patchChat(pool, chatId, { unread: false });
    const afterRead = await queries.chats.findById(pool, chatId);
    expect(afterRead!.unread).toBe(false);

    // Now fire a summary — should NOT flip unread.
    const reqId = generateId("message");
    await queries.messages.insert(pool, {
      id: reqId,
      chatId,
      role: "system",
      content: { type: "summary_request" },
      state: "pending",
      kind: "summary",
      executeAt: new Date().toISOString(),
    });
    await rm.fireMessage(reqId);

    // Unread should still be false after the summary fire.
    const afterSummary = await queries.chats.findById(pool, chatId);
    expect(afterSummary!.unread).toBe(false);
    // updated_at should not have changed from the mark-read snapshot.
    expect(afterSummary!.updatedAt).toBe(afterRead!.updatedAt);
  });

  it("listWithLatestMessage returns unread=false after a summary fire on a read chat", async () => {
    const chatId = await freshChat();
    const rm = createRunManager({
      pool,
      execRunFn: async (runId, _a, _p, onLog) => {
        onLog({ runId, seq: 0, kind: "stdout", payload: '{"type":"text","part":{"text":"# Summary\\nDone."}}' });
        return { exitCode: 0 };
      },
    });

    // Send a user message (sets unread=1) then mark read.
    await sendMessage(pool, chatId, { content: "test" }, () => {});
    await patchChat(pool, chatId, { unread: false });

    // Fire the agent turn to produce visible output (sets unread=1).
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE chat_id = ? AND json_extract(content, '$.type') = 'agent_turn'`,
      [chatId],
    );
    if (rows.length > 0) await rm.fireMessage(rows[0].id);

    // Mark read again.
    await patchChat(pool, chatId, { unread: false });

    // Now fire a summary.
    const reqId = generateId("message");
    await queries.messages.insert(pool, {
      id: reqId,
      chatId,
      role: "system",
      content: { type: "summary_request" },
      state: "pending",
      kind: "summary",
      executeAt: new Date().toISOString(),
    });
    await rm.fireMessage(reqId);

    // The sidebar query should still show unread=false.
    const list = await queries.chats.listWithLatestMessage(pool, workspaceId);
    const found = list.find((c) => c.id === chatId);
    expect(found!.unread).toBe(false);
  });

  // ── End-to-end: WS event payloads for internal messages ────────────────────

  it("all WS events emitted during a summary fire carry internal content types", async () => {
    const chatId = await freshChat();
    const events: WsEvent[] = [];
    const rm = createRunManager({
      pool,
      emit: (e) => events.push(e),
      execRunFn: async (runId, _a, _p, onLog) => {
        onLog({ runId, seq: 0, kind: "stdout", payload: '{"type":"text","part":{"text":"# Summary\\nTest summary."}}' });
        return { exitCode: 0 };
      },
    });

    // Insert and fire a summary_request.
    const reqId = generateId("message");
    await queries.messages.insert(pool, {
      id: reqId,
      chatId,
      role: "system",
      content: { type: "summary_request" },
      state: "pending",
      kind: "summary",
      executeAt: new Date().toISOString(),
    });
    await rm.fireMessage(reqId);

    // Every message.appended event must be internal:
    // The client-side isInternal check mirrors the server-side one.
    const appendedEvents = events.filter((e) => e.type === "message.appended");
    expect(appendedEvents.length).toBeGreaterThan(0);
    for (const evt of appendedEvents) {
      const msg = evt.payload as { content?: { type?: string }; kind?: string };
      const ct = msg.content?.type;
      const mk = msg.kind ?? "chat";
      const isInternal =
        ct === "agent_turn" ||
        ct === "summary_request" ||
        ct === "summary" ||
        ct === "artifactRef" ||
        mk === "summary";
      expect(isInternal).toBe(true);
    }

    // No chat.updated events should have been emitted (summary doesn't
    // change the chat row at all).
    const chatUpdatedEvents = events.filter((e) => e.type === "chat.updated");
    expect(chatUpdatedEvents.length).toBe(0);
  });

  it("all WS events emitted during a regular agent_turn fire include non-internal output", async () => {
    const chatId = await freshChat();
    const events: WsEvent[] = [];
    const rm = createRunManager({
      pool,
      emit: (e) => events.push(e),
      execRunFn: async (runId, _a, _p, onLog) => {
        onLog({ runId, seq: 0, kind: "stdout", payload: '{"type":"text","part":{"text":"Hello!"}}' });
        return { exitCode: 0 };
      },
    });

    // Send a message (creates agent_turn trigger).
    const { triggerId } = await sendMessage(pool, chatId, { content: "hi" }, (e) => events.push(e));
    await rm.fireMessage(triggerId);

    // The events output child should NOT be internal.
    const appendedEvents = events.filter((e) => e.type === "message.appended");
    const nonInternalAppended = appendedEvents.filter((evt) => {
      const msg = evt.payload as { content?: { type?: string }; kind?: string };
      const ct = msg.content?.type;
      const mk = msg.kind ?? "chat";
      return !(
        ct === "agent_turn" ||
        ct === "summary_request" ||
        ct === "summary" ||
        ct === "artifactRef" ||
        mk === "summary"
      );
    });
    // At least the user text message and the events output are non-internal.
    expect(nonInternalAppended.length).toBeGreaterThanOrEqual(2);
  });
});
