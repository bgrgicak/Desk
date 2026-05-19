/**
 * Integration tests for per-chat message scrollback via
 * `GET /chats/:id/messages?before=<cursor>`.
 *
 * Verifies that the API correctly returns older messages in chronological
 * order, includes `prevCursor` when there are more older messages, and
 * stops (no `prevCursor`) when the beginning of the conversation is reached.
 * Also verifies the initial (no-cursor) load returns the newest page and
 * that forward pagination works end-to-end through the HTTP layer.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@agent-desk/db";
import { runMigrations, queries, hashPassword } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId, type Message } from "@agent-desk/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let token: string;
let chatId: string;
let workspaceId: string;
let agentId: string;

/** IDs of the 12 seeded messages, in chronological insertion order. */
const seededIds: string[] = [];

function request(
  method: string,
  pathStr: string,
  authToken: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    };
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathStr, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-scrollback-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-scrollback-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const runManager = createRunManager({
    pool,
    execRunFn: async () => ({ exitCode: 0 }),
  });
  server = createApp({ pool, storage: { pool, home }, runManager });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  // Seed user, workspace, agent, chat.
  const userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "scrollback_user",
    passwordHash: await hashPassword("pw-scrollback"),
    email: "scrollback@example.com",
  });

  agentId = generateId("agent");
  await queries.agents.insert(pool, {
    id: agentId,
    userId,
    name: "ScrollbackAgent",
    model: "opencode/big-pickle",
  });

  const wsId = generateId("workspace");
  workspaceId = wsId;
  await queries.workspaces.insert(pool, {
    id: wsId,
    userId,
    name: "ScrollbackWS",
    description: "",
    icon: "",
  });
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`,
    [wsId, agentId],
  );

  chatId = generateId("chat");
  await queries.chats.insert(pool, {
    id: chatId,
    workspaceId: wsId,
    agentId,
    title: "Scrollback Test Chat",
  });

  // Seed 12 messages with a small delay between each to ensure distinct
  // created_at values for deterministic ordering.
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2));
    const id = generateId("message");
    const role = i % 2 === 0 ? "user" : "agent";
    await queries.messages.insert(pool, {
      id,
      chatId,
      role,
      content: { type: "text", text: `Message ${i + 1} of 12` },
    });
    seededIds.push(id);
  }

  // Login.
  const login = await request("POST", "/auth/login", "");
  // Manual login with body.
  const loginRes = await new Promise<{ status: number; body: unknown }>(
    (resolve, reject) => {
      const payload = JSON.stringify({
        username: "scrollback_user",
        password: "pw-scrollback",
      });
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/auth/login",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(payload)),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(raw),
            });
          });
        },
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    },
  );
  token = (loginRes.body as { token: string }).token;
});

afterAll(async () => {
  await clearSessions(pool);
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath)
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
});

describe("GET /chats/:id/messages — initial load (no cursor)", () => {
  it("returns the newest page with items in chronological order", async () => {
    // With limit=5, we should get the 5 newest messages.
    const res = await request(
      "GET",
      `/chats/${chatId}/messages`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      items: Message[];
      prevCursor?: string;
      cursor?: string;
    };

    // Default limit is 50, so all 12 messages fit in one page.
    expect(body.items).toHaveLength(12);
    // No prevCursor since everything fits.
    expect(body.prevCursor).toBeUndefined();
    // Items in chronological order (ASC).
    for (let i = 1; i < body.items.length; i++) {
      expect(body.items[i - 1].createdAt <= body.items[i].createdAt).toBe(true);
    }
    // All seeded IDs present.
    const returnedIds = body.items.map((m) => m.id);
    expect(returnedIds).toEqual(seededIds);
  });
});

describe("GET /chats/:id/messages — scrollback (before)", () => {
  it("returns the newest page with prevCursor when limit < total", async () => {
    // Fetch only 5 newest. There are 12 total, so prevCursor must be set.
    // The backend default limit is 50, so we need to use a smaller page
    // via the DB limit. Since the HTTP endpoint doesn't expose `limit`,
    // we test via the DB query directly for page-size control and verify
    // the HTTP layer passes `before` correctly.
    const newest = await queries.messages.listByChat(pool, chatId, { limit: 5 });
    expect(newest.items).toHaveLength(5);
    expect(newest.prevCursor).toBeDefined();

    // Items are the 5 newest in chronological order.
    const newestIds = newest.items.map((m) => m.id);
    expect(newestIds).toEqual(seededIds.slice(7)); // indices 7..11
  });

  it("loads older page via before cursor", async () => {
    const newest = await queries.messages.listByChat(pool, chatId, { limit: 5 });
    const older = await queries.messages.listByChat(pool, chatId, {
      before: newest.prevCursor,
      limit: 5,
    });

    expect(older.items).toHaveLength(5);
    // Items are in chronological order.
    for (let i = 1; i < older.items.length; i++) {
      expect(older.items[i - 1].createdAt <= older.items[i].createdAt).toBe(
        true,
      );
    }
    // Older page items come before newest page items.
    const oldestInOlder = older.items[older.items.length - 1];
    const newestInNewest = newest.items[0];
    expect(oldestInOlder.createdAt <= newestInNewest.createdAt).toBe(true);

    // IDs are indices 2..6.
    const olderIds = older.items.map((m) => m.id);
    expect(olderIds).toEqual(seededIds.slice(2, 7));
  });

  it("reaches the beginning of conversation (no prevCursor)", async () => {
    const newest = await queries.messages.listByChat(pool, chatId, { limit: 5 });
    const middle = await queries.messages.listByChat(pool, chatId, {
      before: newest.prevCursor,
      limit: 5,
    });
    const oldest = await queries.messages.listByChat(pool, chatId, {
      before: middle.prevCursor,
      limit: 5,
    });

    // Only 2 messages remain (indices 0 and 1).
    expect(oldest.items).toHaveLength(2);
    // No more older messages.
    expect(oldest.prevCursor).toBeUndefined();

    const oldestIds = oldest.items.map((m) => m.id);
    expect(oldestIds).toEqual(seededIds.slice(0, 2));
  });

  it("concatenating all pages yields the full message set in order", async () => {
    const newest = await queries.messages.listByChat(pool, chatId, { limit: 5 });
    const middle = await queries.messages.listByChat(pool, chatId, {
      before: newest.prevCursor,
      limit: 5,
    });
    const oldest = await queries.messages.listByChat(pool, chatId, {
      before: middle.prevCursor,
      limit: 5,
    });

    const all = [...oldest.items, ...middle.items, ...newest.items];
    expect(all.map((m) => m.id)).toEqual(seededIds);
  });
});

describe("GET /chats/:id/messages — HTTP before param", () => {
  it("passes the before query param through to the DB layer", async () => {
    // First, get a cursor from the DB layer.
    const newest = await queries.messages.listByChat(pool, chatId, { limit: 5 });
    expect(newest.prevCursor).toBeDefined();

    // Now use the HTTP endpoint with the before param.
    const res = await request(
      "GET",
      `/chats/${chatId}/messages?before=${encodeURIComponent(newest.prevCursor!)}`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as { items: Message[]; prevCursor?: string };

    // With the default limit of 50, all 7 remaining messages should come back.
    expect(body.items).toHaveLength(7);
    // Items in chronological order.
    for (let i = 1; i < body.items.length; i++) {
      expect(body.items[i - 1].createdAt <= body.items[i].createdAt).toBe(true);
    }
    // No prevCursor since 7 < 50.
    expect(body.prevCursor).toBeUndefined();

    // IDs are the first 7 messages.
    const ids = body.items.map((m) => m.id);
    expect(ids).toEqual(seededIds.slice(0, 7));
  });

  it("returns empty items when before cursor is older than all messages", async () => {
    // Use a cursor older than anything in the DB.
    const ancientCursor = "2000-01-01T00:00:00.000Z|msg_000000000000000000000";
    const res = await request(
      "GET",
      `/chats/${chatId}/messages?before=${encodeURIComponent(ancientCursor)}`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as { items: Message[]; prevCursor?: string };
    expect(body.items).toHaveLength(0);
    expect(body.prevCursor).toBeUndefined();
  });
});

describe("GET /chats/:id/messages — forward pagination (cursor)", () => {
  it("returns messages after the cursor in chronological order", async () => {
    // Get all messages, take the third one as cursor.
    const all = await queries.messages.listByChat(pool, chatId);
    const third = all.items[2];
    const cursor = `${third.createdAt}|${third.id}`;

    const res = await request(
      "GET",
      `/chats/${chatId}/messages?cursor=${encodeURIComponent(cursor)}`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as { items: Message[]; nextCursor?: string };
    // 12 total minus first 3 = 9 remaining.
    expect(body.items).toHaveLength(9);
    // All items are after the cursor chronologically.
    for (const m of body.items) {
      expect(m.createdAt >= third.createdAt).toBe(true);
      expect(m.id).not.toBe(third.id);
    }
  });
});

describe("GET /chats/:id/messages — compact view", () => {
  it("defaults to the payload-trimmed timeline view unless full is explicit", async () => {
    const defaultChatId = generateId("chat");
    await queries.chats.insert(pool, {
      id: defaultChatId,
      workspaceId,
      agentId,
      title: "Default trimmed payload chat",
    });

    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId: defaultChatId,
      role: "user",
      content: { type: "text", text: "Visible prompt" },
    });
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId: defaultChatId,
      role: "agent",
      content: {
        type: "events",
        log: [
          { kind: "event", event: { type: "tool", part: { input: "hidden".repeat(2000) } } },
          { kind: "event", event: { type: "text", part: { text: "Visible answer" } } },
        ],
      },
    });
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId: defaultChatId,
      role: "agent",
      content: { type: "toolResult", toolName: "large", result: { blob: "payload".repeat(2000) } },
    });
    const summaryId = generateId("message");
    await queries.messages.insert(pool, {
      id: summaryId,
      chatId: defaultChatId,
      role: "system",
      content: { type: "summary", body: "summary".repeat(2000) },
    });
    const summaryRequestId = generateId("message");
    await queries.messages.insert(pool, {
      id: summaryRequestId,
      chatId: defaultChatId,
      role: "system",
      content: { type: "summary_request", reason: "scheduled" },
    });
    const reflectionRequestId = generateId("message");
    await queries.messages.insert(pool, {
      id: reflectionRequestId,
      chatId: defaultChatId,
      role: "system",
      content: { type: "reflection_request", workspaceId },
    });

    const trimmed = await request("GET", `/chats/${defaultChatId}/messages`, token);
    const full = await request("GET", `/chats/${defaultChatId}/messages?view=full`, token);
    expect(trimmed.status).toBe(200);
    expect(full.status).toBe(200);

    const trimmedBody = trimmed.body as { items: Message[] };
    const fullBody = full.body as { items: Message[] };
    const trimmedJson = JSON.stringify(trimmedBody);
    const fullJson = JSON.stringify(fullBody);

    expect(trimmedJson.length).toBeLessThan(fullJson.length / 10);
    expect(trimmedJson).not.toContain("hiddenhiddenhidden");
    expect(trimmedJson).not.toContain("payloadpayloadpayload");
    expect(trimmedBody.items.map((m) => m.id)).not.toContain(summaryId);
    expect(trimmedBody.items.map((m) => m.id)).not.toContain(summaryRequestId);
    expect(trimmedBody.items.map((m) => m.id)).not.toContain(reflectionRequestId);
    expect(fullJson).toContain("hiddenhiddenhidden");
    expect(fullJson).toContain("payloadpayloadpayload");
    expect(fullBody.items.map((m) => m.id)).toContain(summaryId);
    expect(fullBody.items.map((m) => m.id)).toContain(summaryRequestId);
    expect(fullBody.items.map((m) => m.id)).toContain(reflectionRequestId);
  });

  it("omits hidden tool/event payloads while preserving visible text", async () => {
    const compactChatId = generateId("chat");
    await queries.chats.insert(pool, {
      id: compactChatId,
      workspaceId,
      agentId,
      title: "Compact payload chat",
    });
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId: compactChatId,
      role: "agent",
      content: {
        type: "events",
        log: [
          { kind: "unparsed", line: "Legacy visible line" },
          { kind: "event", event: { type: "tool", part: { input: "x".repeat(5000) } } },
          { kind: "event", event: { type: "text", part: { text: "Visible answer" } } },
          { kind: "stderr", line: "debug".repeat(1000) },
        ],
      },
    });
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId: compactChatId,
      role: "agent",
      content: { type: "toolResult", toolName: "large", result: { blob: "y".repeat(5000) } },
    });

    const compact = await request("GET", `/chats/${compactChatId}/messages?view=compact`, token);
    const full = await request("GET", `/chats/${compactChatId}/messages?view=full`, token);
    expect(compact.status).toBe(200);
    expect(full.status).toBe(200);

    const compactBody = compact.body as { items: Message[] };
    const fullBody = full.body as { items: Message[] };
    expect(JSON.stringify(compactBody).length).toBeLessThan(JSON.stringify(fullBody).length / 4);
    expect(JSON.stringify(compactBody)).not.toContain("x".repeat(100));
    expect(JSON.stringify(compactBody)).not.toContain("y".repeat(100));
    expect(JSON.stringify(compactBody)).not.toContain("debugdebugdebug");

    const events = compactBody.items.find((m) => m.content.type === "events")!;
    expect(events.content).toEqual({
      type: "events",
      log: [
        { kind: "unparsed", line: "Legacy visible line" },
        { kind: "event", event: { type: "text", part: { text: "Visible answer" } } },
      ],
    });
    const toolResult = compactBody.items.find((m) => m.content.type === "toolResult")!;
    expect(toolResult.content).toEqual({ type: "toolResult", toolName: "large", result: null });
  });

  it("preserves structured model/provider error events in compact timeline payloads", async () => {
    const errorChatId = generateId("chat");
    await queries.chats.insert(pool, {
      id: errorChatId,
      workspaceId,
      agentId,
      title: "Compact structured error chat",
    });
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId: errorChatId,
      role: "agent",
      content: {
        type: "events",
        log: [
          { kind: "event", event: { type: "tool", part: { input: "hidden".repeat(1000) } } },
          { kind: "event", event: { type: "error", error: { name: "UnknownError", data: { message: "Model not found: openai/gpt-5.5." } } } },
        ],
      },
    });

    const compact = await request("GET", `/chats/${errorChatId}/messages?view=compact`, token);
    expect(compact.status).toBe(200);

    const compactBody = compact.body as { items: Message[] };
    expect(JSON.stringify(compactBody)).not.toContain("hiddenhiddenhidden");
    const events = compactBody.items.find((m) => m.content.type === "events")!;
    expect(events.content).toEqual({
      type: "events",
      log: [
        { kind: "event", event: { type: "error", error: { name: "UnknownError", data: { message: "Model not found: openai/gpt-5.5." } } } },
      ],
    });
  });

  it("timeline view keeps UI-critical rows and drops request-only rows", async () => {
    const timelineChatId = generateId("chat");
    await queries.chats.insert(pool, {
      id: timelineChatId,
      workspaceId,
      agentId,
      title: "Timeline payload chat",
    });

    const inserted: Record<string, string> = {};
    async function add(name: string, role: "user" | "agent" | "system", content: Message["content"], state?: Message["state"]) {
      await new Promise((r) => setTimeout(r, 2));
      const id = generateId("message");
      await queries.messages.insert(pool, { id, chatId: timelineChatId, role, content, state });
      inserted[name] = id;
    }

    await add("user", "user", { type: "text", text: "Visible prompt" });
    await add("oldTurn", "system", { type: "agent_turn", userMessageId: inserted.user }, "succeeded");
    await add("oldTool", "agent", { type: "toolResult", toolName: "old", result: { blob: "old".repeat(4000) } });
    await add("oldSummary", "system", { type: "summary", body: "summary".repeat(1000) });
    await add("answer", "agent", {
      type: "events",
      log: [
        { kind: "unparsed", line: "Legacy visible line" },
        { kind: "event", event: { type: "tool", part: { input: "hidden".repeat(1000) } } },
      ],
    });
    await add("latestTurn", "system", { type: "agent_turn", userMessageId: inserted.user }, "succeeded");
    await add("latestTool", "agent", { type: "toolResult", toolName: "latest", result: { blob: "new".repeat(4000) } });

    const timeline = await request("GET", `/chats/${timelineChatId}/messages?view=timeline`, token);
    const compact = await request("GET", `/chats/${timelineChatId}/messages?view=compact`, token);
    expect(timeline.status).toBe(200);
    expect(compact.status).toBe(200);

    const timelineBody = timeline.body as { items: Message[] };
    const compactBody = compact.body as { items: Message[] };
    const ids = timelineBody.items.map((m) => m.id);
    expect(ids).toContain(inserted.user);
    expect(ids).toContain(inserted.oldTurn);
    expect(ids).toContain(inserted.oldTool);
    expect(ids).toContain(inserted.answer);
    expect(ids).toContain(inserted.latestTurn);
    // Keep hidden markers/triggers so the UI can still render typing/error and
    // historical tool-only completion fallbacks, but drop summaries.
    expect(ids).toContain(inserted.latestTool);
    expect(ids).not.toContain(inserted.oldSummary);

    expect(JSON.stringify(timelineBody).length).toBeLessThan(JSON.stringify(compactBody).length);
    expect(JSON.stringify(timelineBody)).not.toContain("oldoldoldold");
    expect(JSON.stringify(timelineBody)).not.toContain("newnewnewnew");
    expect(JSON.stringify(timelineBody)).not.toContain("hiddenhiddenhidden");
    const answer = timelineBody.items.find((m) => m.id === inserted.answer)!;
    expect(answer.content).toEqual({ type: "events", log: [{ kind: "unparsed", line: "Legacy visible line" }] });
  });

  it("full/dev pages are a superset of regular timeline pages even when summaries are interleaved", async () => {
    const devChatId = generateId("chat");
    await queries.chats.insert(pool, {
      id: devChatId,
      workspaceId,
      agentId,
      title: "Dev mode superset chat",
    });

    const inserted: Record<string, string> = {};
    async function add(name: string, role: "user" | "agent" | "system", content: Message["content"], state?: Message["state"]) {
      await new Promise((r) => setTimeout(r, 2));
      const id = generateId("message");
      await queries.messages.insert(pool, { id, chatId: devChatId, role, content, state });
      inserted[name] = id;
    }

    await add("regular1", "user", { type: "text", text: "Regular 1" });
    await add("summary1", "system", { type: "summary", body: "Summary 1" });
    await add("request1", "system", { type: "summary_request" });
    await add("regular2", "agent", { type: "text", text: "Regular 2" });
    await add("summary2", "system", { type: "summary", body: "Summary 2" });
    await add("tool", "agent", { type: "toolCall", toolName: "read", args: { filePath: "/home/agent/x" } });
    await add("regular3", "user", { type: "text", text: "Regular 3" });

    const timeline = await queries.messages.listByChat(pool, devChatId, { view: "timeline", limit: 3 });
    const full = await queries.messages.listByChat(pool, devChatId, { view: "full", limit: 3 });

    const timelineIds = timeline.items.map((m) => m.id);
    const fullIds = full.items.map((m) => m.id);

    expect(timelineIds).toEqual([inserted.regular2, inserted.tool, inserted.regular3]);
    for (const id of timelineIds) expect(fullIds).toContain(id);
    expect(fullIds).toContain(inserted.summary2);
    expect(full.items.length).toBeGreaterThan(timeline.items.length);
    expect(full.prevCursor).toBe(timeline.prevCursor);
  });

  it("full/dev scrollback pages are a superset of regular timeline scrollback pages", async () => {
    const devChatId = generateId("chat");
    await queries.chats.insert(pool, {
      id: devChatId,
      workspaceId,
      agentId,
      title: "Dev mode scrollback superset chat",
    });

    const inserted: Record<string, string> = {};
    const created: Record<string, string> = {};
    async function add(name: string, role: "user" | "agent" | "system", content: Message["content"]) {
      await new Promise((r) => setTimeout(r, 2));
      const id = generateId("message");
      const msg = await queries.messages.insert(pool, { id, chatId: devChatId, role, content });
      inserted[name] = id;
      created[name] = msg.createdAt;
    }

    await add("regular1", "user", { type: "text", text: "Regular 1" });
    await add("summary1", "system", { type: "summary", body: "Summary 1" });
    await add("regular2", "agent", { type: "text", text: "Regular 2" });
    await add("summary2", "system", { type: "summary", body: "Summary 2" });
    await add("tool", "agent", { type: "toolResult", toolName: "read", result: { ok: true } });
    await add("before", "user", { type: "text", text: "Before cursor" });

    const before = `${created.before}|${inserted.before}`;
    const timeline = await queries.messages.listByChat(pool, devChatId, { view: "timeline", before, limit: 2 });
    const full = await queries.messages.listByChat(pool, devChatId, { view: "full", before, limit: 2 });

    const timelineIds = timeline.items.map((m) => m.id);
    const fullIds = full.items.map((m) => m.id);

    expect(timelineIds).toEqual([inserted.regular2, inserted.tool]);
    for (const id of timelineIds) expect(fullIds).toContain(id);
    expect(fullIds).toContain(inserted.summary2);
    expect(fullIds).not.toContain(inserted.before);
    expect(full.prevCursor).toBe(timeline.prevCursor);
  });

  it("full/dev forward pages are a superset of regular timeline forward pages", async () => {
    const devChatId = generateId("chat");
    await queries.chats.insert(pool, {
      id: devChatId,
      workspaceId,
      agentId,
      title: "Dev mode forward superset chat",
    });

    const inserted: Record<string, string> = {};
    const created: Record<string, string> = {};
    async function add(name: string, role: "user" | "agent" | "system", content: Message["content"]) {
      await new Promise((r) => setTimeout(r, 2));
      const id = generateId("message");
      const msg = await queries.messages.insert(pool, { id, chatId: devChatId, role, content });
      inserted[name] = id;
      created[name] = msg.createdAt;
    }

    await add("cursor", "user", { type: "text", text: "Before cursor" });
    await add("regular1", "user", { type: "text", text: "Regular 1" });
    await add("summary1", "system", { type: "summary", body: "Summary 1" });
    await add("regular2", "agent", { type: "text", text: "Regular 2" });
    await add("summary2", "system", { type: "summary", body: "Summary 2" });
    await add("regular3", "user", { type: "text", text: "Regular 3" });

    const cursor = `${created.cursor}|${inserted.cursor}`;
    const timeline = await queries.messages.listByChat(pool, devChatId, { view: "timeline", cursor, limit: 2 });
    const full = await queries.messages.listByChat(pool, devChatId, { view: "full", cursor, limit: 2 });

    const timelineIds = timeline.items.map((m) => m.id);
    const fullIds = full.items.map((m) => m.id);

    expect(timelineIds).toEqual([inserted.regular1, inserted.regular2]);
    for (const id of timelineIds) expect(fullIds).toContain(id);
    expect(fullIds).toContain(inserted.summary1);
    expect(fullIds).not.toContain(inserted.regular3);
    expect(full.nextCursor).toBe(timeline.nextCursor);
  });
});
