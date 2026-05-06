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
import {
  ensureLayout,
  ensureWorkspaceLayout,
  workspaceRootPath,
  indexLibraryFile,
  indexAppManifest,
  indexFragmentManifest,
} from "@agent-desk/storage";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let workspaceASlug: string;
let workspaceAId: string;
let agentId: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-sandbox-find-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "find-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-sandbox-find-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const { rows: wsRows } = await pool.query<{ id: string; path: string }>(
    "SELECT id, path FROM workspaces LIMIT 1",
  );
  workspaceAId = wsRows[0].id;
  workspaceASlug = wsRows[0].path;
  await ensureWorkspaceLayout(home, workspaceASlug);

  const { rows: agentRows } = await pool.query<{ id: string }>("SELECT id FROM agents LIMIT 1");
  agentId = agentRows[0].id;

  // Seed library content via the indexer.
  const root = workspaceRootPath(home, workspaceASlug);
  await fs.mkdir(path.join(root, "notes"), { recursive: true });
  await fs.writeFile(path.join(root, "notes/kanban.md"), "Kanban setup notes");
  await indexLibraryFile(pool, home, workspaceASlug, "notes/kanban.md");

  await fs.mkdir(path.join(root, "todos.app/fragments/list"), { recursive: true });
  await fs.writeFile(
    path.join(root, "todos.app/desk.app.json"),
    JSON.stringify({
      name: "todos",
      description: "Manage daily tasks and pin them across chats.",
    }),
  );
  await fs.writeFile(
    path.join(root, "todos.app/fragments/list/desk.fragment.json"),
    JSON.stringify({
      name: "list",
      description: "Inline list view of todos.",
      params: { "filter?": "all | open | done" },
    }),
  );
  await indexAppManifest(pool, home, workspaceASlug, "todos.app");
  await indexFragmentManifest(pool, home, workspaceASlug, "todos.app/fragments/list");

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

function sandboxGet(urlPath: string, token: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "GET",
        headers: { "X-Desk-Sandbox-Token": token },
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
    req.end();
  });
}

async function issueSandboxToken(workspaceId: string): Promise<string> {
  const token = `tok_${crypto.randomBytes(16).toString("hex")}`;
  await queries.sandboxSessions.issue(pool, {
    id: generateId("sandboxSession"),
    agentId,
    workspaceId,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
  });
  return token;
}

describe("GET /sandbox/find/artifacts", () => {
  it("returns library artifacts scoped to the session's workspace", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/find/artifacts?q=${encodeURIComponent("kanban")}`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as { hits: Array<{ kind: string; path: string }> };
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits[0].path).toBe("notes/kanban.md");
    expect(body.hits[0].kind).toBe("note");
  });

  it("filters by kind=fragment", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/find/artifacts?q=${encodeURIComponent("list")}&kind=fragment`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as { hits: Array<{ kind: string; path: string }> };
    expect(body.hits.length).toBe(1);
    expect(body.hits[0].kind).toBe("fragment");
    expect(body.hits[0].path).toBe("todos.app/fragments/list");
  });

  it("returns recently-modified artifacts when no query is provided", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(`/sandbox/find/artifacts`, token);
    expect(res.status).toBe(200);
    const body = res.body as { hits: Array<{ path: string }> };
    expect(body.hits.length).toBeGreaterThan(0);
  });

  it("rejects without a sandbox token (401)", async () => {
    const res = await sandboxGet(
      `/sandbox/find/artifacts?q=anything`,
      "tok_does-not-exist",
    );
    expect(res.status).toBe(401);
  });
});
