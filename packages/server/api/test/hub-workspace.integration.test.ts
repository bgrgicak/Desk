/**
 * Integration tests for the per-user hub workspace.
 *
 * The hub is hidden from `GET /workspaces` so the user-facing sidebar
 * doesn't show it, but it's otherwise a regular workspace reachable by
 * id through every standard endpoint. This is what lets the Ask AI chat
 * — which lives in the hub — ride the same code paths as any other chat
 * without per-route special-casing.
 *
 *   - `GET /workspaces` omits the hub (`listWorkspaces` filters `kind=hub`)
 *   - `GET /workspaces/{hub-id}` returns the hub row (200)
 *   - `PATCH /workspaces/{hub-id}` accepts non-rename edits; renaming is
 *     blocked with 403 by the dedicated guard in patchWorkspace
 *   - `DELETE /workspaces/{hub-id}` returns 403 — the hub is permanent
 *   - `GET /chats?workspaceId=<hub-id>`, `GET /library?...`, and the
 *     pins endpoints all return real data
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@roomy-ai/db";
import { runMigrations, queries, hashPassword } from "@roomy-ai/db";
import { ensureLayout } from "@roomy-ai/storage";
import { createRunManager } from "@roomy-ai/scheduler";
import { generateId } from "@roomy-ai/shared";
import { createApp } from "../src/app.js";
import { createHub, ensureHubsForAllUsers } from "../src/routes/workspaces.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let token: string;
let userId: string;
let userSlug: string;

function request(
  method: string,
  urlPath: string,
  t: string | null,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (t) headers.Authorization = `Bearer ${t}`;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
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

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-hub-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-hub-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;
  process.env.ROOMY_DAILY_REFLECTION = "off";

  const runManager = createRunManager({
    pool,
    execRunFn: async () => ({ exitCode: 0 }),
  });
  server = createApp({ pool, storage: { pool, home }, runManager });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  userId = generateId("user");
  userSlug = "hubuser";
  await queries.users.insert(pool, {
    id: userId,
    username: userSlug,
    passwordHash: await hashPassword("pw"),
    email: "hubuser@example.com",
  });
  // Mimic the server boot pass.
  await ensureHubsForAllUsers(pool, home);

  const login = await request("POST", "/auth/login", null, {
    email: "hubuser@example.com",
    password: "pw",
  });
  token = (login.body as { token: string }).token;
});

afterAll(async () => {
  await clearSessions(pool);
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.ROOMY_HOME;
  delete process.env.ROOMY_DAILY_REFLECTION;
});

describe("hub workspace boot pass", () => {
  it("creates a hub for every existing user", async () => {
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    expect(hub).not.toBeNull();
    expect(hub!.kind).toBe("hub");
    expect(hub!.path).toBe(`${userSlug}-hub`);
  });

  it("is idempotent — a second boot pass does not create a duplicate", async () => {
    const before = await queries.workspaces.listByUser(pool, userId);
    await ensureHubsForAllUsers(pool, home);
    const after = await queries.workspaces.listByUser(pool, userId);
    expect(after.length).toBe(before.length);
    expect(after.filter((w) => w.kind === "hub")).toHaveLength(1);
  });

  it("does not seed any chats or messages in the hub workspace", async () => {
    // The hub is created empty — users start their own chats. createHub
    // intentionally inserts no chat, no greeting, and no agent message.
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM chats WHERE workspace_id = ?`,
      [hub!.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("does not re-seed anything on a second createHub call for the same user", async () => {
    // Idempotency contract: createHub may be invoked from boot, login,
    // and any future trigger. It must never inject content into the
    // workspace's chats — neither into the hub itself nor into any
    // user-created chat the user has added.
    const reuserId = generateId("user");
    await queries.users.insert(pool, {
      id: reuserId,
      username: "reuser",
      passwordHash: await hashPassword("pw"),
      email: "reuser@example.com",
    });
    const hub = await createHub(pool, home, reuserId, "reuser");

    // Simulate a user-created chat with a single user message and no
    // agent reply yet — the exact shape that would have triggered the
    // old greeting-injection bug.
    const memberships = await queries.workspaceAgents.listForWorkspace(pool, hub.id);
    const agentId = memberships[0]!.agentId;
    const userChat = await queries.chats.insert(pool, {
      id: generateId("chat"),
      workspaceId: hub.id,
      agentId,
      title: "Can we build a small Todo app?",
    });
    await queries.messages.insert(pool, {
      id: generateId("message"),
      chatId: userChat.id,
      role: "user",
      content: { type: "text", text: "Can we build a small Todo app?" },
    });

    await createHub(pool, home, reuserId, "reuser");

    const userChatMessages = await queries.messages.listByChat(pool, userChat.id, {});
    const agentMessagesInUserChat = userChatMessages.items.filter(
      (m) => m.role === "agent" && m.content.type === "text",
    );
    expect(agentMessagesInUserChat).toHaveLength(0);

    const { rows: allChats } = await pool.query<{ id: string }>(
      `SELECT id FROM chats WHERE workspace_id = ?`,
      [hub.id],
    );
    expect(allChats).toHaveLength(1);
  });

  it("creates a hub for a freshly-inserted user when the boot pass runs", async () => {
    const newUserId = generateId("user");
    await queries.users.insert(pool, {
      id: newUserId,
      username: "freshuser",
      passwordHash: await hashPassword("pw"),
      email: "fresh@example.com",
    });
    expect(await queries.workspaces.findHubByUser(pool, newUserId)).toBeNull();
    await ensureHubsForAllUsers(pool, home);
    const hub = await queries.workspaces.findHubByUser(pool, newUserId);
    expect(hub).not.toBeNull();
    expect(hub!.path).toBe("freshuser-hub");
  });
});

describe("GET /workspaces", () => {
  it("includes the hub workspace in the list", async () => {
    const hubRow = await queries.workspaces.findHubByUser(pool, userId);
    expect(hubRow).not.toBeNull();

    const create = await request("POST", "/workspaces", token, {
      name: "Project Alpha",
    });
    expect(create.status).toBe(201);

    const list = await request("GET", "/workspaces", token);
    expect(list.status).toBe(200);
    const items = list.body as Array<{ id: string; kind: string; path: string }>;
    expect(items.length).toBeGreaterThanOrEqual(2);
    const hubItem = items.find(w => w.id === hubRow!.id);
    expect(hubItem).toBeDefined();
    expect(hubItem!.kind).toBe("hub");
    const projectItems = items.filter(w => w.kind === "project");
    expect(projectItems.length).toBeGreaterThanOrEqual(1);
  });
});

describe("workspace CRUD guards", () => {
  it("rejects a client-supplied kind on POST /workspaces", async () => {
    const res = await request("POST", "/workspaces", token, {
      name: "trying to be a hub",
      kind: "hub",
    });
    expect(res.status).toBe(400);
  });

  it("rejects creation when the slug ends in a reserved suffix", async () => {
    const res = await request("POST", "/workspaces", token, {
      name: "Imposter Hub",
    });
    expect(res.status).toBe(400);
  });

  it("rejects renaming a project workspace into a reserved suffix", async () => {
    const create = await request("POST", "/workspaces", token, {
      name: "Reserved Rename Target",
    });
    expect(create.status).toBe(201);
    const wsId = (create.body as { id: string }).id;
    const rename = await request("PATCH", `/workspaces/${wsId}`, token, {
      name: "another-hub",
    });
    expect(rename.status).toBe(400);
  });

  it("GET on the hub by id returns the hub row", async () => {
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    const res = await request("GET", `/workspaces/${hub!.id}`, token);
    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id).toBe(hub!.id);
    expect((res.body as { kind: string }).kind).toBe("hub");
  });

  it("rejects renaming the hub with 403", async () => {
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    const res = await request("PATCH", `/workspaces/${hub!.id}`, token, {
      name: "Renamed Hub",
    });
    expect(res.status).toBe(403);
  });

  it("rejects deleting the hub with 403", async () => {
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    const res = await request("DELETE", `/workspaces/${hub!.id}`, token);
    expect(res.status).toBe(403);
  });
});

describe("hub workspace — chats and library access", () => {
  it("GET /chats?workspaceId=<hub-id> returns the hub's chats", async () => {
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    const res = await request("GET", `/chats?workspaceId=${hub!.id}`, token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /library?workspaceId=<hub-id> returns the hub's library", async () => {
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    const res = await request("GET", `/library?workspaceId=${hub!.id}`, token);
    expect(res.status).toBe(200);
  });
});

describe("pins — hub endpoints serve cross-workspace pin storage", () => {
  // Pins live on the hub workspace by design. With the hub addressable
  // through the regular workspace endpoints, the pin routes work the same
  // as any other workspace-scoped route — owner-only access, standard
  // 404/200/201 status codes.
  let hubId: string;
  let projectId: string;

  beforeAll(async () => {
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    hubId = hub!.id;
    const create = await request("POST", "/workspaces", token, { name: "Pin Source" });
    projectId = (create.body as { id: string }).id;
  });

  it("GET /workspaces/{hub-id}/pins returns the pin list", async () => {
    const res = await request("GET", `/workspaces/${hubId}/pins`, token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("POST /workspaces/{hub-id}/pins creates a pin", async () => {
    const res = await request("POST", `/workspaces/${hubId}/pins`, token, {
      sourceWorkspaceId: projectId,
      kind: "chat",
      refId: "cht_fake123",
    });
    expect(res.status).toBe(201);
  });

  it("DELETE /workspaces/{hub-id}/pins/{pinId} 404s for an unknown pin", async () => {
    const res = await request("DELETE", `/workspaces/${hubId}/pins/pin_anything`, token);
    expect(res.status).toBe(404);
  });
});

describe("project workspace chats/messages with hub present", () => {
  // Regression guard: even with a hub workspace in the DB, project
  // workspace chats and messages remain fully accessible via the API.
  let projectId: string;
  let agentId: string;

  beforeAll(async () => {
    // Create a project workspace with an agent — mirrors what the DB seed
    // does for a real installation.
    const create = await request("POST", "/workspaces", token, { name: "Project With Messages" });
    expect(create.status).toBe(201);
    projectId = (create.body as { id: string }).id;

    // Reuse the user's existing agent (created during ensureHubsForAllUsers).
    const workspaces = await queries.workspaces.listByUser(pool, userId);
    const hub = workspaces.find((w) => w.kind === "hub")!;
    const memberships = await queries.workspaceAgents.listForWorkspace(pool, hub.id);
    agentId = memberships[0].agentId;

    // Enrol the agent in the project workspace (idempotent — hub init may have
    // already enrolled the same agent in a shared test DB).
    await pool.query(
      `INSERT OR IGNORE INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`,
      [projectId, agentId],
    );
  });

  it("GET /chats?workspaceId=<project-id> lists project chats (not hub chats)", async () => {
    const res = await request("GET", `/chats?workspaceId=${projectId}`, token);
    expect(res.status).toBe(200);
    const chats = res.body as Array<{ id: string; workspaceId: string }>;
    // Any chats returned must belong to the project workspace, not the hub.
    for (const c of chats) {
      expect(c.workspaceId).toBe(projectId);
    }
  });

  it("POST /chats in project workspace then GET /chats/{id}/messages returns messages", async () => {
    // Create a chat in the project workspace.
    const chatRes = await request("POST", "/chats", token, {
      workspaceId: projectId,
      agentId,
      title: "Project Test Chat",
    });
    expect(chatRes.status).toBe(201);
    const chatId = (chatRes.body as { id: string }).id;

    // Send a user message — stored as content.type = 'text', included in the
    // default timeline view.
    const msgRes = await request("POST", `/chats/${chatId}/messages`, token, {
      content: "hello from project workspace",
    });
    expect(msgRes.status).toBe(201);

    // Retrieve messages with the default timeline view.
    const listRes = await request("GET", `/chats/${chatId}/messages`, token);
    expect(listRes.status).toBe(200);
    const body = listRes.body as { items: Array<{ content: { type: string; text?: string } }> };
    const textMessages = body.items.filter((m) => m.content.type === "text");
    expect(textMessages.length).toBeGreaterThanOrEqual(1);
    expect(textMessages[0].content.text).toBe("hello from project workspace");
  });

  it("GET /chats/{project-chat-id} returns 200 with correct workspaceId", async () => {
    const chatRes = await request("POST", "/chats", token, {
      workspaceId: projectId,
      agentId,
      title: "Get By Id Test",
    });
    const chatId = (chatRes.body as { id: string }).id;

    const getRes = await request("GET", `/chats/${chatId}`, token);
    expect(getRes.status).toBe(200);
    expect((getRes.body as { workspaceId: string }).workspaceId).toBe(projectId);
  });
});

describe("GET /me/ask-ai-chat", () => {
  // The hub is hidden from `GET /workspaces`, so the Home → Ask AI
  // surface needs a dedicated endpoint to discover its chat id. The
  // endpoint must:
  //   - create the chat on first call when the hub has none
  //   - return that same chat on subsequent calls (no duplicates)
  //   - hand back a chat the caller can post messages to via
  //     `POST /chats/{id}/messages` (the regular chat surface still
  //     accepts hub-owned chat ids because `requireOwnedChat` only
  //     checks user ownership, not workspace kind)

  it("creates the hub's Ask AI chat on first call", async () => {
    const hub = await queries.workspaces.findHubByUser(pool, userId);
    expect(hub).not.toBeNull();
    // Sanity check: no chats in the hub before we call the endpoint.
    // (Earlier tests in this suite never seed hub chats.)
    const before = await queries.chats.listWithLatestMessage(pool, hub!.id);
    expect(before).toHaveLength(0);

    const res = await request("GET", "/me/ask-ai-chat", token);
    expect(res.status).toBe(200);
    const chat = res.body as { id: string; workspaceId: string; title: string };
    expect(chat.id).toMatch(/^cht_/);
    expect(chat.workspaceId).toBe(hub!.id);
    expect(chat.title).toBe("Ask AI");
  });

  it("returns the same chat on a second call (idempotent)", async () => {
    const first = await request("GET", "/me/ask-ai-chat", token);
    const second = await request("GET", "/me/ask-ai-chat", token);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((first.body as { id: string }).id).toBe((second.body as { id: string }).id);
  });

  it("posting to the returned chat id works through the regular chat API", async () => {
    const chatRes = await request("GET", "/me/ask-ai-chat", token);
    const chatId = (chatRes.body as { id: string }).id;

    const sendRes = await request("POST", `/chats/${chatId}/messages`, token, {
      content: "hello from ask ai",
    });
    expect(sendRes.status).toBe(201);

    const listRes = await request("GET", `/chats/${chatId}/messages`, token);
    expect(listRes.status).toBe(200);
    const body = listRes.body as { items: Array<{ content: { type: string; text?: string } }> };
    const textMessages = body.items.filter((m) => m.content.type === "text");
    expect(textMessages.some((m) => m.content.text === "hello from ask ai")).toBe(true);
  });

  it("401s without an auth token", async () => {
    const res = await request("GET", "/me/ask-ai-chat", null);
    expect(res.status).toBe(401);
  });

  // Regression: before the title-based lookup, getOrCreateAskAiChat
  // picked the oldest chat in the hub by `created_at ASC`. The daily
  // reflection chat inserted with `created_at = ''` (the schema's
  // empty-string default; migration 0042 couldn't use a non-constant
  // ALTER TABLE default) silently sorted before every real ISO
  // timestamp and hijacked the slot — users opening "Ask AI" got the
  // workspace reflection chat (full of `reflection_request` plumbing
  // and journal entries) instead of their own thread.
  it("creates a fresh Ask AI chat when an internal hub chat predates it", async () => {
    const regUserId = generateId("user");
    const regUserSlug = "askai-regression";
    await queries.users.insert(pool, {
      id: regUserId,
      username: regUserSlug,
      passwordHash: await hashPassword("pw"),
      email: "askai-regression@example.com",
    });
    await createHub(pool, home, regUserId, regUserSlug);
    const regHub = await queries.workspaces.findHubByUser(pool, regUserId);
    expect(regHub).not.toBeNull();

    // Seed an internal chat the same way a daily-reflection insert
    // would (empty `created_at`, different title) — this reproduces
    // the corrupted ordering the old lookup tripped over.
    const [regAgent] = await queries.workspaceAgents.listForWorkspace(pool, regHub!.id);
    expect(regAgent).toBeDefined();
    const intruderId = generateId("chat");
    await pool.query(
      `INSERT INTO chats (id, workspace_id, agent_id, title, unread, created_at)
       VALUES (?, ?, ?, ?, 0, '')`,
      [intruderId, regHub!.id, regAgent.agentId, "Workspace reflection"],
    );

    const login = await request("POST", "/auth/login", null, {
      email: "askai-regression@example.com",
      password: "pw",
    });
    const regToken = (login.body as { token: string }).token;

    const res = await request("GET", "/me/ask-ai-chat", regToken);
    expect(res.status).toBe(200);
    const chat = res.body as { id: string; workspaceId: string; title: string };
    expect(chat.workspaceId).toBe(regHub!.id);
    expect(chat.title).toBe("Ask AI");
    expect(chat.id).not.toBe(intruderId);
  });
});

describe("pins — project workspaces cannot use hub-only pin endpoints", () => {
  let projectId: string;

  beforeAll(async () => {
    const create = await request("POST", "/workspaces", token, { name: "No Pins Here" });
    projectId = (create.body as { id: string }).id;
  });

  it("GET /workspaces/{project-id}/pins returns 403", async () => {
    const res = await request("GET", `/workspaces/${projectId}/pins`, token);
    expect(res.status).toBe(403);
  });

  it("POST /workspaces/{project-id}/pins returns 403", async () => {
    const res = await request("POST", `/workspaces/${projectId}/pins`, token, {
      sourceWorkspaceId: projectId,
      kind: "chat",
      refId: "cht_shouldfail",
    });
    expect(res.status).toBe(403);
  });
});
