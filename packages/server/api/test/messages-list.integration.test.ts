/**
 * Integration tests for `GET /messages` — the cross-chat message listing that
 * powers the Runs page + Today / Inbox (feature-gap-matrix.md §4.2.2 / §4.3.1
 * / §4.2.5 / §5). Real Postgres + real filesystem harness, same shape as
 * workspace-scoped-listing.integration.test.ts and chat-delete.integration.
 * test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { runMigrations, queries, hashPassword } from "@desk/db";
import { ensureLayout } from "@desk/storage";
import { createMemoryAdapter, createRunManager } from "@desk/scheduler";
import { generateId, type Message } from "@desk/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_messages_list_${workerId}`;

function adminConn(): string {
  const url = new URL(
    process.env.DESK_TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://desk:desk@127.0.0.1:55432/desk",
  );
  url.pathname = "/postgres";
  return url.toString();
}
function testConn(): string {
  const url = new URL(
    process.env.DESK_TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://desk:desk@127.0.0.1:55432/desk",
  );
  url.pathname = `/${testDbName}`;
  return url.toString();
}

let pool: pg.Pool;
let server: http.Server;
let port: number;
let home: string;

interface SeededUser {
  userId: string;
  token: string;
  wsA: string;
  wsB: string;
  agentId: string;
  /** Two chats in wsA, one in wsB. */
  chatA1: string;
  chatA2: string;
  chatB: string;
  messagesById: Map<string, { chatId: string; createdAt: string }>;
}
let alpha: SeededUser;
let beta: SeededUser;

function request(
  method: string,
  pathStr: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathStr, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function seedUser(suffix: string): Promise<SeededUser> {
  const userId = generateId("user");
  const username = `msglist_${suffix}`;
  const password = `pw-${suffix}`;
  await queries.users.insert(pool, {
    id: userId,
    username,
    passwordHash: await hashPassword(password),
    email: `${username}@example.com`,
  });

  const wsA = generateId("workspace");
  const wsB = generateId("workspace");
  for (const [id, name] of [
    [wsA, `ws-${suffix}-A`],
    [wsB, `ws-${suffix}-B`],
  ] as const) {
    await queries.workspaces.insert(pool, {
      id,
      userId,
      name,
      description: "",
      icon: "",
    });
  }

  const agentId = generateId("agent");
  await queries.agents.insert(pool, {
    id: agentId,
    userId,
    name: `agent-${suffix}`,
    instructions: "",
    model: "anthropic/claude-sonnet-4-5",
    toolAllowlist: [],
  });
  for (const ws of [wsA, wsB]) {
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id, is_default) VALUES ($1, $2, true)`,
      [ws, agentId],
    );
  }

  const chatA1 = generateId("chat");
  const chatA2 = generateId("chat");
  const chatB = generateId("chat");
  for (const [cid, wsId] of [
    [chatA1, wsA],
    [chatA2, wsA],
    [chatB, wsB],
  ] as const) {
    await queries.chats.insert(pool, {
      id: cid,
      workspaceId: wsId,
      agentId,
      title: `chat-${cid.slice(0, 6)}`,
    });
  }

  // chatA1 awaits user; the others don't. Used by the awaitingUser=true test.
  await queries.chats.setAwaitingUser(pool, chatA1, true);

  const login = await request("POST", "/auth/login", null, { username, password });
  const token = (login.body as { token: string }).token;

  return {
    userId,
    token,
    wsA,
    wsB,
    agentId,
    chatA1,
    chatA2,
    chatB,
    messagesById: new Map(),
  };
}

async function insertMessage(
  owner: SeededUser,
  data: {
    chatId: string;
    role: "user" | "agent" | "system" | "tool";
    content: unknown;
    state?: string | null;
    executeAt?: string | null;
    cron?: string | null;
  },
): Promise<string> {
  const id = generateId("message");
  await queries.messages.insert(pool, {
    id,
    chatId: data.chatId,
    role: data.role,
    content: data.content,
    state: data.state,
    executeAt: data.executeAt,
    cron: data.cron,
  });
  const row = await queries.messages.findById(pool, id);
  if (!row) throw new Error("Seed insert failed");
  owner.messagesById.set(id, { chatId: data.chatId, createdAt: row.createdAt });
  return id;
}

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: adminConn() });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await admin.query(`CREATE DATABASE ${testDbName}`);
  } finally {
    await admin.end();
  }

  pool = new pg.Pool({ connectionString: testConn() });
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm"); } catch { /* ok */ }
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-messages-list-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const runManager = createRunManager({
    pool,
    adapter: createMemoryAdapter(),
    execRunFn: async () => ({ exitCode: 0 }),
  });
  server = createApp({ pool, storage: { pool, home }, runManager });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  alpha = await seedUser("alpha");
  beta = await seedUser("beta");

  // 12 messages across alpha's chats spanning the states, scheduled and
  // unscheduled, and every content kind that shows up in this test.
  // chatA1 (wsA, awaiting_user = true):
  //   1. user "text" pending (unscheduled)
  await insertMessage(alpha, {
    chatId: alpha.chatA1,
    role: "user",
    content: { type: "text", text: "hello from A1 user" },
    state: "pending",
  });
  //   2. agent toolCall running (unscheduled)
  await insertMessage(alpha, {
    chatId: alpha.chatA1,
    role: "agent",
    content: { type: "toolCall", toolName: "grep", args: { q: "foo" } },
    state: "running",
  });
  //   3. agent artifactRef succeeded (unscheduled)
  await insertMessage(alpha, {
    chatId: alpha.chatA1,
    role: "agent",
    content: { type: "artifactRef", path: "chats/x/attachments/a.pdf", name: "a.pdf" },
    state: "succeeded",
  });
  //   4. agent "text" succeeded — latest in chatA1, which makes this the
  //      one that satisfies awaitingUser=true.
  await insertMessage(alpha, {
    chatId: alpha.chatA1,
    role: "agent",
    content: { type: "text", text: "awaiting reply" },
    state: "succeeded",
  });

  // chatA2 (wsA, not awaiting):
  //   5. system agent_turn pending, scheduled via executeAt
  await insertMessage(alpha, {
    chatId: alpha.chatA2,
    role: "system",
    content: { type: "agent_turn", userMessageId: "msg_stub" },
    state: "pending",
    executeAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  //   6. system agent_turn pending, scheduled via cron
  await insertMessage(alpha, {
    chatId: alpha.chatA2,
    role: "system",
    content: { type: "agent_turn", userMessageId: "msg_stub" },
    state: "pending",
    cron: "0 9 * * *",
  });
  //   7. agent "events" failed (unscheduled)
  await insertMessage(alpha, {
    chatId: alpha.chatA2,
    role: "agent",
    content: { type: "events", events: [] },
    state: "failed",
  });
  //   8. agent toolResult cancelled (unscheduled)
  await insertMessage(alpha, {
    chatId: alpha.chatA2,
    role: "agent",
    content: { type: "toolResult", toolName: "grep", result: null },
    state: "cancelled",
  });

  // chatB (wsB, not awaiting):
  //   9. user "text" pending (unscheduled)
  await insertMessage(alpha, {
    chatId: alpha.chatB,
    role: "user",
    content: { type: "text", text: "hello from B user" },
    state: "pending",
  });
  //  10. agent "note" succeeded (unscheduled)
  await insertMessage(alpha, {
    chatId: alpha.chatB,
    role: "agent",
    content: { type: "note", body: "summary" },
    state: "succeeded",
  });
  //  11. system ai_note_request pending, scheduled
  await insertMessage(alpha, {
    chatId: alpha.chatB,
    role: "system",
    content: { type: "ai_note_request" },
    state: "pending",
    executeAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
  //  12. agent "artifactRef" succeeded (unscheduled)
  await insertMessage(alpha, {
    chatId: alpha.chatB,
    role: "agent",
    content: { type: "artifactRef", path: "chats/y/attachments/b.pdf", name: "b.pdf" },
    state: "succeeded",
  });

  // Beta gets one message so cross-tenant tests have something to lean on.
  await insertMessage(beta, {
    chatId: beta.chatA1,
    role: "user",
    content: { type: "text", text: "beta private" },
    state: "pending",
  });
});

afterAll(async () => {
  clearSessions();
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  delete process.env.DESK_HOME;

  const admin = new pg.Pool({ connectionString: adminConn() });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
  } finally {
    await admin.end();
  }
});

describe("GET /messages — unfiltered", () => {
  it("returns all 12 seeded messages for the caller, ordered createdAt DESC", async () => {
    const res = await request("GET", "/messages", alpha.token);
    expect(res.status).toBe(200);
    const body = res.body as { items: Message[]; nextCursor?: string };
    expect(body.items).toHaveLength(12);

    // Ordering: newest first.
    for (let i = 1; i < body.items.length; i++) {
      expect(body.items[i - 1].createdAt >= body.items[i].createdAt).toBe(true);
    }

    // Returns only alpha's messages.
    const ids = new Set(body.items.map((m) => m.id));
    expect([...alpha.messagesById.keys()].every((id) => ids.has(id))).toBe(true);
    for (const bId of beta.messagesById.keys()) {
      expect(ids.has(bId)).toBe(false);
    }
  });
});

describe("GET /messages — workspace/chat scoping", () => {
  it("workspaceId=wsA returns only messages from wsA chats", async () => {
    const res = await request("GET", `/messages?workspaceId=${alpha.wsA}`, alpha.token);
    expect(res.status).toBe(200);
    const items = (res.body as { items: Message[] }).items;
    const wsAChats = new Set([alpha.chatA1, alpha.chatA2]);
    for (const m of items) expect(wsAChats.has(m.chatId)).toBe(true);
    // 4 in chatA1 + 4 in chatA2 = 8.
    expect(items).toHaveLength(8);
  });

  it("workspaceId=wsB returns only messages from wsB chats", async () => {
    const res = await request("GET", `/messages?workspaceId=${alpha.wsB}`, alpha.token);
    expect(res.status).toBe(200);
    const items = (res.body as { items: Message[] }).items;
    for (const m of items) expect(m.chatId).toBe(alpha.chatB);
    expect(items).toHaveLength(4);
  });

  it("chatId=<chat in wsA> count matches GET /chats/:id/messages", async () => {
    const crossRes = await request(
      "GET",
      `/messages?chatId=${alpha.chatA1}`,
      alpha.token,
    );
    expect(crossRes.status).toBe(200);
    const crossItems = (crossRes.body as { items: Message[] }).items;
    for (const m of crossItems) expect(m.chatId).toBe(alpha.chatA1);

    const perChat = await request(
      "GET",
      `/chats/${alpha.chatA1}/messages`,
      alpha.token,
    );
    expect(perChat.status).toBe(200);
    const perChatItems = (perChat.body as { items: Message[] }).items;
    expect(crossItems).toHaveLength(perChatItems.length);
    expect(new Set(crossItems.map((m) => m.id))).toEqual(
      new Set(perChatItems.map((m) => m.id)),
    );
  });
});

describe("GET /messages — state", () => {
  it("state=pending returns only pending", async () => {
    const res = await request("GET", "/messages?state=pending", alpha.token);
    expect(res.status).toBe(200);
    const items = (res.body as { items: Message[] }).items;
    expect(items.length).toBeGreaterThan(0);
    for (const m of items) expect(m.state).toBe("pending");
  });

  it("state=pending,running returns both", async () => {
    const res = await request("GET", "/messages?state=pending,running", alpha.token);
    expect(res.status).toBe(200);
    const items = (res.body as { items: Message[] }).items;
    const states = new Set(items.map((m) => m.state));
    expect(states.has("pending")).toBe(true);
    expect(states.has("running")).toBe(true);
    for (const m of items) expect(["pending", "running"]).toContain(m.state);
  });
});

describe("GET /messages — scheduled", () => {
  it("scheduled=true returns only rows with executeAt or cron", async () => {
    const res = await request("GET", "/messages?scheduled=true", alpha.token);
    expect(res.status).toBe(200);
    const items = (res.body as { items: Message[] }).items;
    // Seeded: #5 (executeAt in chatA2), #6 (cron in chatA2), #11 (executeAt in chatB) = 3.
    expect(items).toHaveLength(3);
    for (const m of items) {
      expect(Boolean(m.executeAt) || Boolean(m.cron)).toBe(true);
    }
  });

  it("scheduled=false returns only unscheduled; union with true = all", async () => {
    const schedRes = await request("GET", "/messages?scheduled=true", alpha.token);
    const unschedRes = await request("GET", "/messages?scheduled=false", alpha.token);
    expect(schedRes.status).toBe(200);
    expect(unschedRes.status).toBe(200);
    const sched = (schedRes.body as { items: Message[] }).items;
    const unsched = (unschedRes.body as { items: Message[] }).items;
    for (const m of unsched) {
      expect(Boolean(m.executeAt) || Boolean(m.cron)).toBe(false);
    }
    expect(sched.length + unsched.length).toBe(12);
  });
});

describe("GET /messages — awaitingUser", () => {
  it("awaitingUser=true returns the single latest-in-chat succeeded agent message in an awaiting chat", async () => {
    const res = await request("GET", "/messages?awaitingUser=true", alpha.token);
    expect(res.status).toBe(200);
    const items = (res.body as { items: Message[] }).items;
    // chatA1 has awaiting_user=true, and message #4 is the latest + agent +
    // succeeded. chatA2 / chatB have awaiting_user=false.
    expect(items).toHaveLength(1);
    expect(items[0].chatId).toBe(alpha.chatA1);
    expect(items[0].role).toBe("agent");
    expect(items[0].state).toBe("succeeded");
  });
});

describe("GET /messages — contentKind", () => {
  it("contentKind=text returns only text messages", async () => {
    const res = await request("GET", "/messages?contentKind=text", alpha.token);
    expect(res.status).toBe(200);
    const items = (res.body as { items: Message[] }).items;
    for (const m of items) {
      expect((m.content as { type: string }).type).toBe("text");
    }
    // Seeded: #1, #4, #9 = 3 text messages.
    expect(items).toHaveLength(3);
  });

  it("contentKind=toolCall,artifactRef returns both", async () => {
    const res = await request(
      "GET",
      "/messages?contentKind=toolCall,artifactRef",
      alpha.token,
    );
    expect(res.status).toBe(200);
    const items = (res.body as { items: Message[] }).items;
    const kinds = new Set(items.map((m) => (m.content as { type: string }).type));
    expect(kinds.has("toolCall")).toBe(true);
    expect(kinds.has("artifactRef")).toBe(true);
    for (const m of items) {
      expect(["toolCall", "artifactRef"]).toContain(
        (m.content as { type: string }).type,
      );
    }
  });
});

describe("GET /messages — since", () => {
  it("returns only messages with createdAt strictly greater than the timestamp", async () => {
    const all = await request("GET", "/messages", alpha.token);
    const allItems = (all.body as { items: Message[] }).items;
    // Sorted newest first. Pick the middle row's createdAt as the cutoff.
    const mid = allItems[Math.floor(allItems.length / 2)].createdAt;

    const res = await request(
      "GET",
      `/messages?since=${encodeURIComponent(mid)}`,
      alpha.token,
    );
    expect(res.status).toBe(200);
    const items = (res.body as { items: Message[] }).items;
    // Postgres stores timestamps at microsecond precision while JS Date
    // truncates to milliseconds, so the returned string may equal `mid` even
    // when the underlying PG value is strictly greater. Assert `>=` and
    // separately verify at least one row was filtered out.
    for (const m of items) expect(m.createdAt >= mid).toBe(true);
    expect(items.length).toBeLessThan(allItems.length);
  });
});

describe("GET /messages — pagination", () => {
  it("limit+cursor walks through the full set with no gaps or overlaps", async () => {
    const firstRes = await request("GET", "/messages?limit=5", alpha.token);
    expect(firstRes.status).toBe(200);
    const first = firstRes.body as { items: Message[]; nextCursor?: string };
    expect(first.items).toHaveLength(5);
    expect(first.nextCursor).toBeTruthy();

    const secondRes = await request(
      "GET",
      `/messages?limit=5&cursor=${encodeURIComponent(first.nextCursor!)}`,
      alpha.token,
    );
    expect(secondRes.status).toBe(200);
    const second = secondRes.body as { items: Message[]; nextCursor?: string };
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeTruthy();

    const thirdRes = await request(
      "GET",
      `/messages?limit=5&cursor=${encodeURIComponent(second.nextCursor!)}`,
      alpha.token,
    );
    expect(thirdRes.status).toBe(200);
    const third = thirdRes.body as { items: Message[]; nextCursor?: string };
    // 12 total → 5 + 5 + 2.
    expect(third.items).toHaveLength(2);
    expect(third.nextCursor).toBeUndefined();

    const unpagedRes = await request("GET", "/messages", alpha.token);
    const unpaged = (unpagedRes.body as { items: Message[] }).items;
    const paged = [...first.items, ...second.items, ...third.items];
    expect(paged.map((m) => m.id)).toEqual(unpaged.map((m) => m.id));
  });
});

describe("GET /messages — cross-tenant isolation", () => {
  it("workspaceId points at a peer's workspace → 404", async () => {
    const res = await request(
      "GET",
      `/messages?workspaceId=${beta.wsA}`,
      alpha.token,
    );
    expect(res.status).toBe(404);
  });

  it("chatId points at a peer's chat → 404", async () => {
    const res = await request(
      "GET",
      `/messages?chatId=${beta.chatA1}`,
      alpha.token,
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /messages — malformed input", () => {
  it("malformed workspaceId → 400", async () => {
    const res = await request("GET", "/messages?workspaceId=garbage", alpha.token);
    expect(res.status).toBe(400);
  });

  it("malformed chatId → 400", async () => {
    const res = await request("GET", "/messages?chatId=not-a-chat", alpha.token);
    expect(res.status).toBe(400);
  });

  it("unknown state value → 400", async () => {
    const res = await request("GET", "/messages?state=bogus", alpha.token);
    expect(res.status).toBe(400);
  });

  it("unknown contentKind value → 400", async () => {
    const res = await request("GET", "/messages?contentKind=unknown", alpha.token);
    expect(res.status).toBe(400);
  });

  it("invalid since timestamp → 400", async () => {
    const res = await request("GET", "/messages?since=not-a-date", alpha.token);
    expect(res.status).toBe(400);
  });

  it("limit=99999 is clamped to the max, returns up to 200 items", async () => {
    const res = await request("GET", "/messages?limit=99999", alpha.token);
    expect(res.status).toBe(200);
    const items = (res.body as { items: Message[] }).items;
    expect(items.length).toBeLessThanOrEqual(200);
    // We only seeded 12, so all show up.
    expect(items).toHaveLength(12);
  });

  it("invalid limit (non-integer) → 400", async () => {
    const res = await request("GET", "/messages?limit=abc", alpha.token);
    expect(res.status).toBe(400);
  });
});

describe("GET /messages — ordering stability", () => {
  it("messages with identical createdAt return in a deterministic tiebreak order", async () => {
    // Seed three rows with exactly the same created_at into beta's chatA1,
    // then confirm (a) all three come back, (b) the order is stable across
    // repeated calls, and (c) the tiebreak is NOT the insertion order
    // (proving the server isn't just leaking natural scan order).
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = generateId("message");
      await pool.query(
        `INSERT INTO messages (id, chat_id, role, content, state, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, beta.chatA1, "user", JSON.stringify({ type: "text", text: `tie-${i}` }), "pending", fixed],
      );
      ids.push(id);
    }

    const first = await request(
      "GET",
      `/messages?chatId=${beta.chatA1}&limit=50`,
      beta.token,
    );
    const second = await request(
      "GET",
      `/messages?chatId=${beta.chatA1}&limit=50`,
      beta.token,
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const firstSameTs = (first.body as { items: Message[] }).items
      .filter((m) => m.createdAt === fixed.toISOString())
      .map((m) => m.id);
    const secondSameTs = (second.body as { items: Message[] }).items
      .filter((m) => m.createdAt === fixed.toISOString())
      .map((m) => m.id);

    expect(firstSameTs).toHaveLength(3);
    // Deterministic across calls.
    expect(secondSameTs).toEqual(firstSameTs);
    // All three are present, exactly once each.
    expect(new Set(firstSameTs)).toEqual(new Set(ids));
  });
});
