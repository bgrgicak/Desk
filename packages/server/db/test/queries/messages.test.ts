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
     VALUES (?, ?) ON CONFLICT DO NOTHING`,
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
