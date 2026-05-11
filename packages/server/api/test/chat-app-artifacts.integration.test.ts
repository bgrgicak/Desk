/**
 * PR-B: chat artifact listing surfaces `<name>.app/` directories.
 *
 * Real desk-server, real SQLite, real fs — no fakes. We materialize a
 * `<name>.app/` directory under `~/.chats/<chatId>/artifacts/` (the same
 * shape `desk-agent app create` produces inside the sandbox), call the
 * listing endpoint the chat UI calls, and confirm the entry surfaces with
 * `isDir: true` and `kind: "artifact"` so the client can render it as
 * `type: "app"`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations, seedIfEmpty } from "@agent-desk/db";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId } from "@agent-desk/shared";
import {
  chatArtifactsDir,
  ensureLayout,
  ensureWorkspaceLayout,
} from "@agent-desk/storage";
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
let chatId: string;
let authToken: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-chat-app-art-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "chat-app-art-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-chat-app-art-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const { rows: wsRows } = await pool.query<{ id: string; path: string }>(
    "SELECT id, path FROM workspaces LIMIT 1",
  );
  workspaceId = wsRows[0].id;
  workspaceSlug = wsRows[0].path;
  await ensureWorkspaceLayout(home, workspaceSlug);

  const { rows: agentRows } = await pool.query<{ id: string }>("SELECT id FROM agents LIMIT 1");
  const agentId = agentRows[0].id;

  chatId = generateId("chat");
  await pool.query(
    "INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)",
    [chatId, workspaceId, agentId, "Chat Apps Test"],
  );

  const { rows: userRows } = await pool.query<{ id: string }>("SELECT id FROM users LIMIT 1");
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
    username: "chat-app-art-user",
    password: "pw",
  });
  authToken = (login.body as { token: string }).token;
  // Silence the unused workspaceId binding when the test below doesn't
  // need it directly — it's still used to construct paths.
  void workspaceId;
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
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

interface AttachmentRow {
  path: string;
  name: string;
  isDir?: boolean;
  kind?: string;
  mime?: string;
}

describe("GET /chats/:id/attachments — `<name>.app/` chat artifacts (PR-B)", () => {
  it("surfaces `<name>.app/` directories with isDir:true and kind:artifact", async () => {
    const artDir = chatArtifactsDir(home, workspaceSlug, chatId);
    const appDir = path.join(artDir, "my-app.app");
    await fs.mkdir(path.join(appDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(appDir, "desk.app.json"),
      JSON.stringify({
        name: "my-app",
        displayName: "my-app",
        description: "Test app",
        version: "0.1.0",
        capabilities: [],
        fragments: ["example"],
      }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(appDir, "src", "main.tsx"),
      "// stub",
      "utf8",
    );

    const res = await httpJson(
      "GET",
      `/chats/${chatId}/attachments?includeArtifacts=true`,
      authToken,
    );
    expect(res.status).toBe(200);
    const items = res.body as AttachmentRow[];
    const appEntry = items.find((it) => it.name === "my-app.app");
    expect(appEntry, `expected my-app.app in ${JSON.stringify(items)}`).toBeTruthy();
    expect(appEntry?.isDir).toBe(true);
    expect(appEntry?.kind).toBe("artifact");
    // The path is the workspace-relative location of the directory; the
    // client uses this exact value as the attachment path when navigating.
    expect(appEntry?.path).toBe(`.chats/${chatId}/artifacts/my-app.app`);
    // The manifest inside the directory is reachable through the same
    // listing endpoint — the chat UI's PR-B click handler navigates at
    // `<dir>/desk.app.json`, so confirm the file is on disk where the
    // client expects.
    const manifestStat = await fs.stat(path.join(appDir, "desk.app.json"));
    expect(manifestStat.isFile()).toBe(true);
  });

  it("does not return the `.app/` entry when includeArtifacts is false", async () => {
    const res = await httpJson(
      "GET",
      `/chats/${chatId}/attachments`,
      authToken,
    );
    expect(res.status).toBe(200);
    const items = res.body as AttachmentRow[];
    expect(items.find((it) => it.name === "my-app.app")).toBeUndefined();
  });

  it("does not surface loose artifact files unless an artifactRef message attached them", async () => {
    const artDir = chatArtifactsDir(home, workspaceSlug, chatId);
    await fs.mkdir(artDir, { recursive: true });
    await fs.writeFile(path.join(artDir, "scratch-report.md"), "# Scratch\n", "utf8");
    await fs.writeFile(path.join(artDir, "attached-report.md"), "# Attached\n", "utf8");

    const attachedPath = `.chats/${chatId}/artifacts/attached-report.md`;
    await pool.query(
      "INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, 'agent', ?)",
      [
        generateId("message"),
        chatId,
        JSON.stringify({
          type: "artifactRef",
          path: attachedPath,
          workspaceId,
          name: "attached-report.md",
        }),
      ],
    );

    const res = await httpJson(
      "GET",
      `/chats/${chatId}/attachments?includeArtifacts=true`,
      authToken,
    );

    expect(res.status).toBe(200);
    const items = res.body as AttachmentRow[];
    expect(items.find((it) => it.name === "scratch-report.md")).toBeUndefined();
    expect(items.find((it) => it.name === "attached-report.md")?.path).toBe(attachedPath);
  });
});
