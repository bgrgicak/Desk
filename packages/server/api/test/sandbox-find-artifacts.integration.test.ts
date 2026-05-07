import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
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
  backfillWorkspaceLibrary,
} from "@agent-desk/storage";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";
import * as libraryRoutes from "../src/routes/library.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let workspaceASlug: string;
let workspaceAId: string;
let otherUserWorkspaceSlug: string;
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
  const otherUserId = generateId("user");
  await pool.query(
    `INSERT INTO users (id, username, password_hash, email)
     VALUES (?, 'find-other', 'hash', 'find-other@example.com')`,
    [otherUserId],
  );
  const otherWorkspaceId = generateId("workspace");
  otherUserWorkspaceSlug = `other-${otherWorkspaceId.slice(-6)}`;
  await pool.query(
    `INSERT INTO workspaces (id, user_id, name, path) VALUES (?, ?, ?, ?)`,
    [otherWorkspaceId, otherUserId, "Other WS", otherUserWorkspaceSlug],
  );
  await ensureWorkspaceLayout(home, otherUserWorkspaceSlug);
  const otherRoot = workspaceRootPath(home, otherUserWorkspaceSlug);
  await fs.mkdir(path.join(otherRoot, "notes"), { recursive: true });
  await fs.writeFile(path.join(otherRoot, "notes/private.md"), "Private giraffe plans.");
  await indexLibraryFile(pool, home, otherUserWorkspaceSlug, "notes/private.md");

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

  it("filters by kind=fragment and returns params_schema", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/find/artifacts?q=${encodeURIComponent("list")}&kind=fragment`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      hits: Array<{ kind: string; path: string; params_schema?: Record<string, string> }>;
    };
    expect(body.hits.length).toBe(1);
    expect(body.hits[0].kind).toBe("fragment");
    expect(body.hits[0].path).toBe("todos.app/fragments/list");
    // P86.1 — fragment hits must surface the manifest's params block so
    // the agent can parameterize an inline embed.
    expect(body.hits[0].params_schema).toEqual({ "filter?": "all | open | done" });
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

  it("rejects an explicit workspace slug not owned by the sandbox user", async () => {
    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/find/artifacts?q=${encodeURIComponent("giraffe")}&workspace=${encodeURIComponent(otherUserWorkspaceSlug)}`,
      token,
    );
    expect(res.status).toBe(404);
  });

  it("indexes new files written through the library route (P86.2 on-write hook)", async () => {
    // Drop a note via the library save handler and verify the search
    // index picks it up immediately, with no manual indexer call.
    const root = workspaceRootPath(home, workspaceASlug);
    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    // Pre-create the file so saveContent (overwrite) succeeds; on-write
    // indexing covers create + update.
    await fs.writeFile(path.join(root, "notes/hooked.md"), "");
    await libraryRoutes.saveContent(
      { pool, home },
      workspaceAId,
      "notes/hooked.md",
      Readable.from(["Hooked-on-write content about ferrets."]),
      () => {},
    );

    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/find/artifacts?q=${encodeURIComponent("ferrets")}`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as { hits: Array<{ kind: string; path: string }> };
    expect(body.hits.some((h) => h.path === "notes/hooked.md")).toBe(true);
  });

  it("indexes files placed on disk before backfill (P86.2 boot backfill)", async () => {
    // Simulate boot-time backfill: drop a file directly on disk and
    // call the same helper main.ts runs at startup.
    const root = workspaceRootPath(home, workspaceASlug);
    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    await fs.writeFile(
      path.join(root, "notes/preboot.md"),
      "Preboot note about chinchillas.",
    );
    await backfillWorkspaceLibrary(pool, home, workspaceASlug);

    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/find/artifacts?q=${encodeURIComponent("chinchillas")}`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as { hits: Array<{ kind: string; path: string }> };
    expect(body.hits.some((h) => h.path === "notes/preboot.md")).toBe(true);
  });

  it("removes nested index rows when deleting a folder", async () => {
    const root = workspaceRootPath(home, workspaceASlug);
    await fs.mkdir(path.join(root, "folder-delete"), { recursive: true });
    await fs.writeFile(path.join(root, "folder-delete/nested.md"), "Folder delete wombat note.");
    await backfillWorkspaceLibrary(pool, home, workspaceASlug);

    await libraryRoutes.remove({ pool, home }, workspaceAId, "folder-delete", () => {});

    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/find/artifacts?q=${encodeURIComponent("wombat")}`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as { hits: Array<{ path: string }> };
    expect(body.hits.some((h) => h.path.startsWith("folder-delete/"))).toBe(false);
  });

  it("removes app manifest rows when deleting an app directory with a trailing slash", async () => {
    const root = workspaceRootPath(home, workspaceASlug);
    await fs.mkdir(path.join(root, "trail.app"), { recursive: true });
    await fs.writeFile(
      path.join(root, "trail.app/desk.app.json"),
      JSON.stringify({ name: "trail", description: "Trailing slash app marker." }),
    );
    await backfillWorkspaceLibrary(pool, home, workspaceASlug);

    await libraryRoutes.remove({ pool, home }, workspaceAId, "trail.app/", () => {});

    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/find/artifacts?q=${encodeURIComponent("Trailing slash")}`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as { hits: Array<{ path: string }> };
    expect(body.hits.some((h) => h.path === "trail.app")).toBe(false);
  });

  it("rekeys nested index rows when moving a folder", async () => {
    const root = workspaceRootPath(home, workspaceASlug);
    await fs.mkdir(path.join(root, "folder-move"), { recursive: true });
    await fs.writeFile(path.join(root, "folder-move/nested.md"), "Folder move axolotl note.");
    await backfillWorkspaceLibrary(pool, home, workspaceASlug);

    await libraryRoutes.move({ pool, home }, workspaceAId, "folder-move", "folder-moved", () => {});

    const token = await issueSandboxToken(workspaceAId);
    const res = await sandboxGet(
      `/sandbox/find/artifacts?q=${encodeURIComponent("axolotl")}`,
      token,
    );
    expect(res.status).toBe(200);
    const body = res.body as { hits: Array<{ path: string }> };
    expect(body.hits.some((h) => h.path === "folder-moved/nested.md")).toBe(true);
    expect(body.hits.some((h) => h.path === "folder-move/nested.md")).toBe(false);
  });
});
