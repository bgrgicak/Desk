import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, queries, runMigrations, insertSeedFixture } from "@roomy-ai/db";
import { createRunManager } from "@roomy-ai/scheduler";
import { generateId } from "@roomy-ai/shared";
import { chatArtifactsDir, ensureLayout, ensureWorkspaceLayout } from "@roomy-ai/storage";
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
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-sandbox-artifacts-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  await insertSeedFixture(pool, { username: "artifact-user", password: "pw" });

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-sandbox-artifacts-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;

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
    email: "artifact-user@roomy.local",
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
  delete process.env.ROOMY_HOME;
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
          "X-Roomy-Sandbox-Token": token,
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

async function createRunToken(runChatId = chatId): Promise<string> {
  const runId = generateId("message");
  await pool.query(
    `INSERT INTO messages (id, chat_id, role, content, state)
     VALUES (?, ?, 'system', ?, 'running')`,
    [runId, runChatId, JSON.stringify({ type: "agent_turn", userMessageId: generateId("message") })],
  );
  return issueSandboxToken({ runId });
}

describe("POST /sandbox/artifacts", () => {
  it("creates an agent artifactRef message for a real chat artifact file", async () => {
    const artifactsDir = chatArtifactsDir(home, workspaceSlug, chatId);
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, "report.md"), "# Report\n", "utf8");

    const token = await createRunToken();
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

  it("derives the target chat from the live run token when chatId is omitted", async () => {
    const artifactsDir = chatArtifactsDir(home, workspaceSlug, chatId);
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, "derived-chat.md"), "# Derived chat\n", "utf8");

    const token = await createRunToken();
    const relPath = `.chats/${chatId}/artifacts/derived-chat.md`;

    const res = await sandboxPost("/sandbox/artifacts", { path: relPath }, token);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      chatId,
      content: {
        type: "artifactRef",
        path: relPath,
      },
    });
  });

  it("creates an agent artifactRef message for a .app/ directory artifact", async () => {
    const artifactsDir = chatArtifactsDir(home, workspaceSlug, chatId);
    const appDir = path.join(artifactsDir, "my-todos.app");
    await fs.mkdir(path.join(appDir, "dist"), { recursive: true });
    await fs.writeFile(path.join(appDir, "dist", "index.html"), "<html></html>", "utf8");

    const token = await createRunToken();
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

    const token = await createRunToken();
    const res = await sandboxPost(
      "/sandbox/artifacts",
      { chatId: otherChatId, path: `.chats/${otherChatId}/artifacts/report.md` },
      token,
    );

    // 404 — the workspace-boundary check treats the target chat as not
    // visible from this session, which is semantically a not-found
    // rather than a validation error.
    expect(res.status).toBe(404);
  });

  it("rejects artifact attachment from a workspace-scoped token without a run", async () => {
    const artifactsDir = chatArtifactsDir(home, workspaceSlug, chatId);
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, "unscoped-leak.md"), "# Should not attach\n", "utf8");

    const token = await issueSandboxToken();
    const res = await sandboxPost(
      "/sandbox/artifacts",
      { chatId, path: `.chats/${chatId}/artifacts/unscoped-leak.md` },
      token,
    );

    expect(res.status).toBe(400);
    const messages = await queries.messages.listByChat(pool, chatId);
    expect(messages.items.some((message) => (
      message.content.type === "artifactRef"
      && message.content.path.endsWith("unscoped-leak.md")
    ))).toBe(false);
  });

  // Cross-chat artifact refs are intentional: an agent in chat A can
  // surface a file in chat B (or point chat B at a file living under
  // chat A's artifact dir), as long as both chats are in the same
  // workspace as the session. The cross-workspace boundary stays.
  it("attaches an artifact to a different chat in the same workspace as the run", async () => {
    const sourceRunId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state)
       VALUES (?, ?, 'system', ?, 'running')`,
      [sourceRunId, chatId, JSON.stringify({ type: "agent_turn", userMessageId: generateId("message") })],
    );

    const otherChatId = generateId("chat");
    await pool.query(
      `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
      [otherChatId, workspaceId, agentId, "Same Workspace Other Chat"],
    );
    const otherArtifactsDir = chatArtifactsDir(home, workspaceSlug, otherChatId);
    await fs.mkdir(otherArtifactsDir, { recursive: true });
    await fs.writeFile(path.join(otherArtifactsDir, "cross-chat.md"), "# Cross-chat\n", "utf8");

    const token = await issueSandboxToken({ runId: sourceRunId });
    const res = await sandboxPost(
      "/sandbox/artifacts",
      { chatId: otherChatId, path: `.chats/${otherChatId}/artifacts/cross-chat.md` },
      token,
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      chatId: otherChatId,
      role: "agent",
      content: {
        type: "artifactRef",
        path: `.chats/${otherChatId}/artifacts/cross-chat.md`,
      },
    });
  });

  // The path can reference a *different* chat's artifact dir than the
  // target chat — e.g. chat B is told to surface a file written by the
  // run into chat A's artifact dir. Same-workspace requirement still
  // holds, enforced by the filesystem (the file lookup happens inside
  // the target chat's workspace tree).
  it("attaches an artifact whose path references a different chat than the target chat", async () => {
    const sourceArtifactsDir = chatArtifactsDir(home, workspaceSlug, chatId);
    await fs.mkdir(sourceArtifactsDir, { recursive: true });
    await fs.writeFile(path.join(sourceArtifactsDir, "from-source.md"), "# From source\n", "utf8");

    const targetChatId = generateId("chat");
    await pool.query(
      `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
      [targetChatId, workspaceId, agentId, "Cross-Chat Target"],
    );

    const token = await createRunToken();
    const relPath = `.chats/${chatId}/artifacts/from-source.md`;
    const res = await sandboxPost(
      "/sandbox/artifacts",
      { chatId: targetChatId, path: relPath },
      token,
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      chatId: targetChatId,
      content: { type: "artifactRef", path: relPath },
    });

    const messages = await queries.messages.listByChat(pool, targetChatId);
    expect(messages.items.some((message) => (
      message.role === "agent"
      && message.content.type === "artifactRef"
      && message.content.path === relPath
    ))).toBe(true);
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

  it("rejects artifact attachment from a terminal run token", async () => {
    const artifactsDir = chatArtifactsDir(home, workspaceSlug, chatId);
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, "terminal-run-leak.md"), "# Should not attach\n", "utf8");

    const runId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state)
       VALUES (?, ?, 'system', ?, 'succeeded')`,
      [runId, chatId, JSON.stringify({ type: "agent_turn", userMessageId: generateId("message") })],
    );
    const token = await issueSandboxToken({ runId });

    const res = await sandboxPost(
      "/sandbox/artifacts",
      { chatId, path: `.chats/${chatId}/artifacts/terminal-run-leak.md` },
      token,
    );

    expect(res.status).toBe(400);
    const messages = await queries.messages.listByChat(pool, chatId);
    expect(messages.items.some((message) => (
      message.content.type === "artifactRef"
      && message.content.path.endsWith("terminal-run-leak.md")
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
