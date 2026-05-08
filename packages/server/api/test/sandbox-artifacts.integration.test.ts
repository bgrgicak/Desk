import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, queries, runMigrations, seedIfEmpty } from "@agent-desk/db";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId } from "@agent-desk/shared";
import { chatArtifactsDir, ensureLayout, ensureWorkspaceLayout } from "@agent-desk/storage";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let workspaceId: string;
let workspaceSlug: string;
let userId: string;
let agentId: string;
let chatId: string;
let authToken: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-sandbox-artifacts-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "artifact-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-sandbox-artifacts-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const { rows: wsRows } = await pool.query<{ id: string; path: string }>(
    "SELECT id, path FROM workspaces LIMIT 1",
  );
  workspaceId = wsRows[0].id;
  workspaceSlug = wsRows[0].path;
  await ensureWorkspaceLayout(home, workspaceSlug);

  const { rows: agentRows } = await pool.query<{ id: string }>("SELECT id FROM agents LIMIT 1");
  agentId = agentRows[0].id;

  chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
    [chatId, workspaceId, agentId, "Artifact Chat"],
  );

  const { rows: userRows } = await pool.query<{ id: string }>("SELECT id FROM users LIMIT 1");
  userId = userRows[0].id;
  const runManager = createRunManager({ pool });
  server = createApp({
    pool,
    storage: { pool, home },
    runManager,
    broadcastUserId: userRows[0].id,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  const login = await httpJson("POST", "/auth/login", undefined, {
    username: "artifact-user",
    password: "pw",
  });
  authToken = (login.body as { token: string }).token;
});

afterAll(async () => {
  await clearSessions(pool);
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
});

function sandboxPost(
  urlPath: string,
  body: unknown,
  token: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(payload)),
          "X-Desk-Sandbox-Token": token,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function httpJson(
  method: string,
  urlPath: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    if (token) headers.Authorization = `Bearer ${token}`;

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function issueSandboxToken(opts?: { runId?: string }): Promise<string> {
  const token = `tok_${crypto.randomBytes(16).toString("hex")}`;
  await queries.sandboxSessions.issue(pool, {
    id: generateId("sandboxSession"),
    agentId,
    runId: opts?.runId,
    workspaceId,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
  });
  return token;
}

describe("POST /sandbox/artifacts", () => {
  it("creates an agent artifactRef message for a real chat artifact file", async () => {
    const artifactsDir = chatArtifactsDir(home, workspaceSlug, chatId);
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, "report.md"), "# Report\n", "utf8");

    const token = await issueSandboxToken();
    const relPath = `.chats/${chatId}/artifacts/report.md`;

    const res = await sandboxPost("/sandbox/artifacts", { chatId, path: relPath }, token);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      chatId,
      role: "agent",
      content: {
        type: "artifactRef",
        path: relPath,
        name: "report.md",
      },
    });

    const messages = await queries.messages.listByChat(pool, chatId);
    expect(messages.items.some((message) => (
      message.role === "agent"
      && message.content.type === "artifactRef"
      && message.content.path === relPath
    ))).toBe(true);
  });

  it("creates an agent artifactRef message for a .app/ directory artifact", async () => {
    const artifactsDir = chatArtifactsDir(home, workspaceSlug, chatId);
    const appDir = path.join(artifactsDir, "my-todos.app");
    await fs.mkdir(path.join(appDir, "dist"), { recursive: true });
    await fs.writeFile(path.join(appDir, "dist", "index.html"), "<html></html>", "utf8");

    const token = await issueSandboxToken();
    const relPath = `.chats/${chatId}/artifacts/my-todos.app`;

    const res = await sandboxPost("/sandbox/artifacts", { chatId, path: relPath }, token);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      chatId,
      role: "agent",
      content: {
        type: "artifactRef",
        path: relPath,
        name: "my-todos.app",
        mime: "inode/directory",
      },
    });

    const messages = await queries.messages.listByChat(pool, chatId);
    expect(messages.items.some((message) => (
      message.role === "agent"
      && message.content.type === "artifactRef"
      && message.content.path === relPath
      && message.content.mime === "inode/directory"
    ))).toBe(true);
  });

  it("rejects artifact attachment to a chat outside the token workspace", async () => {
    const otherWorkspaceId = generateId("workspace");
    await queries.workspaces.insert(pool, {
      id: otherWorkspaceId,
      userId,
      name: "Other artifact workspace",
      description: "",
      icon: "",
    });
    const otherWorkspace = await queries.workspaces.findById(pool, otherWorkspaceId);
    if (!otherWorkspace) throw new Error("other workspace insert failed");
    await ensureWorkspaceLayout(home, otherWorkspace.path);
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`,
      [otherWorkspaceId, agentId],
    );
    const otherChatId = generateId("chat");
    await pool.query(
      `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
      [otherChatId, otherWorkspaceId, agentId, "Other Artifact Chat"],
    );
    const otherArtifactsDir = chatArtifactsDir(home, otherWorkspace.path, otherChatId);
    await fs.mkdir(otherArtifactsDir, { recursive: true });
    await fs.writeFile(path.join(otherArtifactsDir, "report.md"), "# Other\n", "utf8");

    const token = await issueSandboxToken();
    const res = await sandboxPost(
      "/sandbox/artifacts",
      { chatId: otherChatId, path: `.chats/${otherChatId}/artifacts/report.md` },
      token,
    );

    expect(res.status).toBe(404);
  });

  it("rejects artifact attachment from a live summary run token", async () => {
    const artifactsDir = chatArtifactsDir(home, workspaceSlug, chatId);
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, "summary-leak.md"), "# Should not attach\n", "utf8");

    const runId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, kind)
       VALUES (?, ?, 'system', ?, 'running', 'summary')`,
      [runId, chatId, JSON.stringify({ type: "summary_request" })],
    );
    const token = await issueSandboxToken({ runId });

    const res = await sandboxPost(
      "/sandbox/artifacts",
      { chatId, path: `.chats/${chatId}/artifacts/summary-leak.md` },
      token,
    );

    expect(res.status).toBe(400);
    const messages = await queries.messages.listByChat(pool, chatId);
    expect(messages.items.some((message) => (
      message.content.type === "artifactRef"
      && message.content.path.endsWith("summary-leak.md")
    ))).toBe(false);
  });

  it("rejects artifact attachment from a summary_request content token even without summary kind", async () => {
    const artifactsDir = chatArtifactsDir(home, workspaceSlug, chatId);
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, "summary-request-leak.md"), "# Should not attach\n", "utf8");

    const runId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state)
       VALUES (?, ?, 'system', ?, 'running')`,
      [runId, chatId, JSON.stringify({ type: "summary_request" })],
    );
    const token = await issueSandboxToken({ runId });

    const res = await sandboxPost(
      "/sandbox/artifacts",
      { chatId, path: `.chats/${chatId}/artifacts/summary-request-leak.md` },
      token,
    );

    expect(res.status).toBe(400);
    const messages = await queries.messages.listByChat(pool, chatId);
    expect(messages.items.some((message) => (
      message.content.type === "artifactRef"
      && message.content.path.endsWith("summary-request-leak.md")
    ))).toBe(false);
  });

  it("rejects artifact attachment from a deleted run token", async () => {
    const artifactsDir = chatArtifactsDir(home, workspaceSlug, chatId);
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, "deleted-run-leak.md"), "# Should not attach\n", "utf8");

    const runId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state)
       VALUES (?, ?, 'system', ?, 'running')`,
      [runId, chatId, JSON.stringify({ type: "agent_turn", userMessageId: generateId("message") })],
    );
    const token = await issueSandboxToken({ runId });
    await pool.query("DELETE FROM messages WHERE id = ?", [runId]);

    const res = await sandboxPost(
      "/sandbox/artifacts",
      { chatId, path: `.chats/${chatId}/artifacts/deleted-run-leak.md` },
      token,
    );

    expect(res.status).toBe(400);
    const messages = await queries.messages.listByChat(pool, chatId);
    expect(messages.items.some((message) => (
      message.content.type === "artifactRef"
      && message.content.path.endsWith("deleted-run-leak.md")
    ))).toBe(false);
  });
});

describe("chat artifact file reads", () => {
  it("rejects traversal out of the chat artifacts directory", async () => {
    const artifactsDir = chatArtifactsDir(home, workspaceSlug, chatId);
    const logsDir = path.join(home, workspaceSlug, ".chats", chatId, "logs");
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(path.join(logsDir, "secret.log"), "secret", "utf8");

    const target = encodeURIComponent(`.chats/${chatId}/artifacts/../logs/secret.log`);
    const res = await httpJson(
      "GET",
      `/library/content?workspaceId=${workspaceId}&path=${target}`,
      authToken,
    );

    expect(res.status).toBe(404);
  });

  it("rejects artifact symlinks that resolve outside the artifacts directory", async () => {
    const artifactsDir = chatArtifactsDir(home, workspaceSlug, chatId);
    const logsDir = path.join(home, workspaceSlug, ".chats", chatId, "logs");
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(path.join(logsDir, "secret-symlink.log"), "secret", "utf8");
    const linkPath = path.join(artifactsDir, "secret-link.md");
    await fs.rm(linkPath, { force: true });
    await fs.symlink(path.join(logsDir, "secret-symlink.log"), linkPath);

    const target = encodeURIComponent(`.chats/${chatId}/artifacts/secret-link.md`);
    const res = await httpJson(
      "GET",
      `/library/content?workspaceId=${workspaceId}&path=${target}`,
      authToken,
    );

    expect(res.status).toBe(404);
  });

  it("rejects an artifacts directory symlink that resolves outside the workspace", async () => {
    const symlinkChatId = generateId("chat");
    await pool.query(
      `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
      [symlinkChatId, workspaceId, agentId, "Symlink Root Chat"],
    );
    const chatDir = path.join(home, workspaceSlug, ".chats", symlinkChatId);
    const outsideDir = path.join(home, "outside-artifacts");
    await fs.mkdir(chatDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "outside.md"), "# Outside\n", "utf8");
    await fs.symlink(outsideDir, path.join(chatDir, "artifacts"));

    const target = encodeURIComponent(`.chats/${symlinkChatId}/artifacts/outside.md`);
    const res = await httpJson(
      "GET",
      `/library/content?workspaceId=${workspaceId}&path=${target}`,
      authToken,
    );

    expect(res.status).toBe(404);
  });

  it("rejects artifact paths whose chat does not belong to the requested workspace", async () => {
    const otherWorkspaceId = generateId("workspace");
    await queries.workspaces.insert(pool, {
      id: otherWorkspaceId,
      userId,
      name: "Read Scope Workspace",
      description: "",
      icon: "",
    });
    const otherWorkspace = await queries.workspaces.findById(pool, otherWorkspaceId);
    if (!otherWorkspace) throw new Error("other workspace insert failed");
    await ensureWorkspaceLayout(home, otherWorkspace.path);
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`,
      [otherWorkspaceId, agentId],
    );
    const otherChatId = generateId("chat");
    await pool.query(
      `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
      [otherChatId, otherWorkspaceId, agentId, "Other Read Chat"],
    );
    const mirrorDir = chatArtifactsDir(home, workspaceSlug, otherChatId);
    await fs.mkdir(mirrorDir, { recursive: true });
    await fs.writeFile(path.join(mirrorDir, "leak.md"), "# Leak\n", "utf8");

    const target = encodeURIComponent(`.chats/${otherChatId}/artifacts/leak.md`);
    const res = await httpJson(
      "GET",
      `/library/content?workspaceId=${workspaceId}&path=${target}`,
      authToken,
    );

    expect(res.status).toBe(404);
  });
});
