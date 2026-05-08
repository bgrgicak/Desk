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

  const agentId = generateId("agent");
  await queries.agents.insert(pool, {
    id: agentId,
    userId,
    name: "ScrollbackAgent",
    model: "opencode/big-pickle",
  });

  const wsId = generateId("workspace");
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
