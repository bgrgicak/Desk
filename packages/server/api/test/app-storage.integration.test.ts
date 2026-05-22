/**
 * PR-H: per-app document-collections storage.
 *
 * Real desk-server, real SQLite (the per-app DB itself is real, not a
 * fake), real fs. Walks the full CRUD contract through the same cookie
 * the static-app route uses, plus the capability gate.
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
  workspaceRootPath,
} from "@agent-desk/storage";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";
import { clearAppSessions } from "../src/routes/apps.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let workspaceSlug: string;
let chatId: string;
let authToken: string;

const RW_APP = "todo-tracker";
const READONLY_APP = "viewer-app";
const LIBRARY_APP = "library-store";

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-storage-int-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "storage-int-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-storage-int-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const { rows: wsRows } = await pool.query<{ id: string; path: string }>(
    "SELECT id, path FROM workspaces LIMIT 1",
  );
  workspaceSlug = wsRows[0].path;
  await ensureWorkspaceLayout(home, workspaceSlug);

  const { rows: agentRows } = await pool.query<{ id: string }>("SELECT id FROM agents LIMIT 1");
  chatId = generateId("chat");
  await pool.query(
    "INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)",
    [chatId, wsRows[0].id, agentRows[0].id, "Storage Test"],
  );

  // Materialize two `.app/` chat artifacts: one with read+write
  // capabilities, one read-only.
  for (const [name, capabilities] of [
    [RW_APP, ["storage.read", "storage.write"]] as const,
    [READONLY_APP, ["storage.read"]] as const,
  ]) {
    const appRoot = path.join(
      chatArtifactsDir(home, workspaceSlug, chatId),
      `${name}.app`,
    );
    await fs.mkdir(path.join(appRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(appRoot, "desk.app.json"),
      JSON.stringify({ name, capabilities }),
      "utf8",
    );
    await fs.writeFile(
      path.join(appRoot, "dist", "index.html"),
      "<!doctype html><html><head></head><body></body></html>",
      "utf8",
    );
  }

  const libraryAppRoot = path.join(workspaceRootPath(home, workspaceSlug), `${LIBRARY_APP}.app`);
  await fs.mkdir(path.join(libraryAppRoot, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(libraryAppRoot, "desk.app.json"),
    JSON.stringify({ name: LIBRARY_APP, capabilities: ["storage.read", "storage.write"] }),
    "utf8",
  );
  await fs.writeFile(
    path.join(libraryAppRoot, "dist", "index.html"),
    "<!doctype html><html><head></head><body></body></html>",
    "utf8",
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

  const login = await httpRaw("POST", "/auth/login", {
    body: { username: "storage-int-user", password: "pw" },
  });
  authToken = (login.bodyJson as { token: string }).token;
});

afterAll(async () => {
  await clearAppSessions(pool);
  await clearSessions(pool);
  clearConnections();
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
});

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  bodyJson: unknown;
}

function httpRaw(
  method: string,
  urlPath: string,
  opts: { body?: unknown; headers?: Record<string, string>; bearer?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: raw,
            bodyJson: parsed,
          });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function pickSetCookie(headers: http.IncomingHttpHeaders, name: string): string | null {
  const raw = headers["set-cookie"] ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  for (const line of list) {
    if (typeof line !== "string") continue;
    const eq = line.indexOf("=");
    if (eq === -1 || line.slice(0, eq) !== name) continue;
    const semi = line.indexOf(";");
    return semi === -1 ? line : line.slice(0, semi);
  }
  return null;
}

async function appCookie(appName: string): Promise<string> {
  const issue = await httpRaw(
    "POST",
    `/apps/chat/${chatId}/${appName}/issue`,
    { bearer: authToken },
  );
  expect(issue.status).toBe(201);
  const data = issue.bodyJson as { url: string; cookieName: string };
  const bootstrap = await httpRaw("GET", data.url);
  // Bootstrap now serves the index inline (200) instead of 302-redirecting.
  // The Set-Cookie still rides along — see apps.ts for the rationale.
  expect(bootstrap.status).toBe(200);
  const cookie = pickSetCookie(bootstrap.headers, data.cookieName);
  if (!cookie) throw new Error(`No cookie set for ${appName}`);
  return cookie;
}

async function libraryAppCookie(appName: string): Promise<{ cookie: string; setCookie: string; appBasePath: string }> {
  const issue = await httpRaw(
    "POST",
    `/apps/library/${appName}/issue`,
    { bearer: authToken },
  );
  expect(issue.status).toBe(201);
  const data = issue.bodyJson as { url: string; cookieName: string };
  const distIndex = data.url.indexOf("/dist");
  const appBasePath = distIndex === -1 ? data.url.split("?")[0] : data.url.slice(0, distIndex);
  const bootstrap = await httpRaw("GET", data.url);
  expect(bootstrap.status).toBe(200);
  const cookie = pickSetCookie(bootstrap.headers, data.cookieName);
  if (!cookie) throw new Error(`No cookie set for ${appName}`);
  const raw = bootstrap.headers["set-cookie"] ?? [];
  const setCookie = (Array.isArray(raw) ? raw : [raw]).find(
    (line): line is string => typeof line === "string" && line.startsWith(`${data.cookieName}=`),
  );
  if (!setCookie) throw new Error(`No Set-Cookie header for ${appName}`);
  return { cookie, setCookie, appBasePath };
}

describe("per-app storage CRUD (PR-H)", () => {
  it("create → list → get → update → delete round-trips for an app with storage.read+write", async () => {
    const cookie = await appCookie(RW_APP);

    // Initial list is empty
    const empty = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${RW_APP}/storage/items`,
      { headers: { Cookie: cookie } },
    );
    expect(empty.status).toBe(200);
    expect((empty.bodyJson as { items: unknown[] }).items).toEqual([]);

    // Create
    const created = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${RW_APP}/storage/items`,
      { headers: { Cookie: cookie }, body: { title: "buy milk", done: false } },
    );
    expect(created.status).toBe(201);
    const createdDoc = created.bodyJson as {
      id: string;
      doc: { title: string; done: boolean };
      createdAt: number;
      updatedAt: number;
    };
    expect(createdDoc.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(createdDoc.doc).toEqual({ title: "buy milk", done: false });

    // List has one
    const list = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${RW_APP}/storage/items`,
      { headers: { Cookie: cookie } },
    );
    expect((list.bodyJson as { items: unknown[] }).items.length).toBe(1);

    // Get one
    const got = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${RW_APP}/storage/items/${createdDoc.id}`,
      { headers: { Cookie: cookie } },
    );
    expect(got.status).toBe(200);
    expect((got.bodyJson as { id: string }).id).toBe(createdDoc.id);

    // Update via PUT
    const updated = await httpRaw(
      "PUT",
      `/apps/chat/${chatId}/${RW_APP}/storage/items/${createdDoc.id}`,
      { headers: { Cookie: cookie }, body: { title: "buy milk", done: true } },
    );
    expect(updated.status).toBe(200);
    expect((updated.bodyJson as { doc: { done: boolean } }).doc.done).toBe(true);
    expect((updated.bodyJson as { createdAt: number }).createdAt)
      .toBe(createdDoc.createdAt);
    expect((updated.bodyJson as { updatedAt: number }).updatedAt)
      .toBeGreaterThanOrEqual(createdDoc.updatedAt);

    // PUT can also create at a chosen id
    const upserted = await httpRaw(
      "PUT",
      `/apps/chat/${chatId}/${RW_APP}/storage/items/sentinel-id-1`,
      { headers: { Cookie: cookie }, body: { title: "manual id", done: false } },
    );
    expect(upserted.status).toBe(200);
    expect((upserted.bodyJson as { id: string }).id).toBe("sentinel-id-1");

    // Delete
    const removed = await httpRaw(
      "DELETE",
      `/apps/chat/${chatId}/${RW_APP}/storage/items/${createdDoc.id}`,
      { headers: { Cookie: cookie } },
    );
    expect(removed.status).toBe(204);

    const afterDelete = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${RW_APP}/storage/items/${createdDoc.id}`,
      { headers: { Cookie: cookie } },
    );
    expect(afterDelete.status).toBe(404);
  });

  it("returns 401 without the per-app cookie", async () => {
    const noCookie = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${RW_APP}/storage/items`,
    );
    expect(noCookie.status).toBe(401);
  });

  it("blocks writes when the manifest doesn't grant storage.write", async () => {
    const cookie = await appCookie(READONLY_APP);

    const reads = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${READONLY_APP}/storage/items`,
      { headers: { Cookie: cookie } },
    );
    expect(reads.status).toBe(200);

    const create = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${READONLY_APP}/storage/items`,
      { headers: { Cookie: cookie }, body: { title: "x" } },
    );
    // 403 (the session is valid; the operation just isn't authorized).
    expect(create.status).toBe(403);
  });

  it("rejects invalid collection names + doc ids", async () => {
    const cookie = await appCookie(RW_APP);
    const badCollection = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${RW_APP}/storage/With%20Space`,
      { headers: { Cookie: cookie } },
    );
    expect(badCollection.status).toBe(400);

    const badDocId = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${RW_APP}/storage/items/has%2Fslash`,
      { headers: { Cookie: cookie } },
    );
    expect(badDocId.status).toBe(400);

    const extraSegment = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${RW_APP}/storage/items/doc_1/extra`,
      { headers: { Cookie: cookie } },
    );
    expect(extraSegment.status).toBe(400);
  });

  it("round-trips library app storage using the library cookie path", async () => {
    const { cookie, setCookie, appBasePath } = await libraryAppCookie(LIBRARY_APP);
    expect(setCookie).toContain(`Path=${appBasePath}`);

    const created = await httpRaw(
      "POST",
      `${appBasePath}/storage/items`,
      { headers: { Cookie: cookie }, body: { title: "library doc" } },
    );
    expect(created.status).toBe(201);
    const createdDoc = created.bodyJson as { id: string; doc: { title: string } };
    expect(createdDoc.doc.title).toBe("library doc");

    const listed = await httpRaw(
      "GET",
      `${appBasePath}/storage/items`,
      { headers: { Cookie: cookie } },
    );
    expect(listed.status).toBe(200);
    const list = listed.bodyJson as { items: Array<{ id: string; doc: { title: string } }> };
    expect(list.items.map((item) => item.id)).toContain(createdDoc.id);
  });

  it("creates the storage SQLite file on disk inside the app directory", async () => {
    const cookie = await appCookie(RW_APP);
    await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${RW_APP}/storage/items`,
      { headers: { Cookie: cookie }, body: { x: 1 } },
    );
    const dbFile = path.join(
      chatArtifactsDir(home, workspaceSlug, chatId),
      `${RW_APP}.app`,
      ".storage",
      "data.sqlite",
    );
    const stat = await fs.stat(dbFile);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(0);
  });

  it("writes land in whichever inode currently lives at the path, even after the .app/ is moved out from under us", async () => {
    // Regression for the dbCache bug: PR-G's `replaceLibraryAppFromChat`
    // does two `fs.rename`s — the cached connection used to point at
    // the trashed inode, so subsequent writes went to .trash instead of
    // the new file. Simulate that swap directly here. After the swap
    // the storage path resolves to a new inode, and the next write must
    // land there, not in the renamed-aside file.
    const RENAME_APP = "rename-test";
    const appRoot = path.join(
      chatArtifactsDir(home, workspaceSlug, chatId),
      `${RENAME_APP}.app`,
    );
    await fs.mkdir(path.join(appRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(appRoot, "desk.app.json"),
      JSON.stringify({ name: RENAME_APP, capabilities: ["storage.read", "storage.write"] }),
      "utf8",
    );
    // Bootstrap now serves dist/index.html inline (previously it 302'd
    // before any file lookup); these storage-only fixtures need a stub.
    await fs.writeFile(path.join(appRoot, "dist", "index.html"), "<!doctype html><html></html>", "utf8");

    const cookie = await appCookie(RENAME_APP);

    // First write — creates `<appRoot>/.storage/data.sqlite` (call it inode-A).
    const create = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${RENAME_APP}/storage/items`,
      { headers: { Cookie: cookie }, body: { which: "inode-A" } },
    );
    expect(create.status).toBe(201);

    // Move the entire `.app/` aside (mimics PR-G's first rename:
    // library-copy → trash). The old data.sqlite goes with it.
    const aside = path.join(
      chatArtifactsDir(home, workspaceSlug, chatId),
      `${RENAME_APP}-aside.app`,
    );
    await fs.rename(appRoot, aside);

    // Stage a fresh `.app/` at the original path with empty storage —
    // mimics PR-G's second rename: chat-copy → library.
    await fs.mkdir(path.join(appRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(appRoot, "desk.app.json"),
      JSON.stringify({ name: RENAME_APP, capabilities: ["storage.read", "storage.write"] }),
      "utf8",
    );
    await fs.writeFile(path.join(appRoot, "dist", "index.html"), "<!doctype html><html></html>", "utf8");

    // Issue a fresh session for the new inode (the old session may
    // still be valid, but a real PR-G replace would issue anew via
    // the parent SPA — re-issue here too).
    const cookie2 = await appCookie(RENAME_APP);

    // Second write must land in the NEW file (inode-B), not aside.
    const second = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${RENAME_APP}/storage/items`,
      { headers: { Cookie: cookie2 }, body: { which: "inode-B" } },
    );
    expect(second.status).toBe(201);

    // List the new app's docs — should contain only inode-B's row,
    // never inode-A's. (Connection reuse across the rename would have
    // written inode-B's row into the aside file, leaving the new
    // file's docs empty.)
    const list = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${RENAME_APP}/storage/items`,
      { headers: { Cookie: cookie2 } },
    );
    expect(list.status).toBe(200);
    const items = (list.bodyJson as { items: Array<{ doc: { which: string } }> }).items;
    expect(items.map((i) => i.doc.which)).toEqual(["inode-B"]);

    // And the aside file's data.sqlite should still hold the inode-A
    // row — confirming the test setup is sound.
    const asideDb = path.join(aside, ".storage", "data.sqlite");
    const asideStat = await fs.stat(asideDb);
    expect(asideStat.size).toBeGreaterThan(0);
  });

  it("paginates list with limit + cursor", async () => {
    // Use a fresh app + collection so prior tests don't perturb the page.
    const PAGE_APP = "page-app";
    const appRoot = path.join(
      chatArtifactsDir(home, workspaceSlug, chatId),
      `${PAGE_APP}.app`,
    );
    await fs.mkdir(path.join(appRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(appRoot, "desk.app.json"),
      JSON.stringify({ name: PAGE_APP, capabilities: ["storage.read", "storage.write"] }),
      "utf8",
    );
    await fs.writeFile(path.join(appRoot, "dist", "index.html"), "<!doctype html><html></html>", "utf8");
    const cookie = await appCookie(PAGE_APP);

    // Insert 5 docs.
    for (let i = 0; i < 5; i++) {
      await httpRaw(
        "POST",
        `/apps/chat/${chatId}/${PAGE_APP}/storage/items`,
        { headers: { Cookie: cookie }, body: { i } },
      );
    }

    // Page 1: 2 docs, expect a nextCursor.
    const p1 = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${PAGE_APP}/storage/items?limit=2`,
      { headers: { Cookie: cookie } },
    );
    expect(p1.status).toBe(200);
    const page1 = p1.bodyJson as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(page1.items.length).toBe(2);
    expect(typeof page1.nextCursor).toBe("string");

    // Page 2 via cursor.
    const p2 = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${PAGE_APP}/storage/items?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      { headers: { Cookie: cookie } },
    );
    const page2 = p2.bodyJson as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(page2.items.length).toBe(2);
    expect(typeof page2.nextCursor).toBe("string");

    // Page 3: only 1 left, nextCursor null.
    const p3 = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${PAGE_APP}/storage/items?limit=2&cursor=${encodeURIComponent(page2.nextCursor!)}`,
      { headers: { Cookie: cookie } },
    );
    const page3 = p3.bodyJson as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(page3.items.length).toBe(1);
    expect(page3.nextCursor).toBeNull();

    // Pages don't overlap.
    const all = [...page1.items, ...page2.items, ...page3.items].map((i) => i.id);
    expect(new Set(all).size).toBe(5);

    // Bad limit returns 400.
    const badLimit = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${PAGE_APP}/storage/items?limit=abc`,
      { headers: { Cookie: cookie } },
    );
    expect(badLimit.status).toBe(400);

    const badCursor = await httpRaw(
      "GET",
      `/apps/chat/${chatId}/${PAGE_APP}/storage/items?cursor=not-a-cursor`,
      { headers: { Cookie: cookie } },
    );
    expect(badCursor.status).toBe(400);
  });

  it("rejects symlinked storage directories instead of writing outside the app", async () => {
    const SYMLINK_APP = "symlink-store";
    const appRoot = path.join(
      chatArtifactsDir(home, workspaceSlug, chatId),
      `${SYMLINK_APP}.app`,
    );
    await fs.mkdir(path.join(appRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(appRoot, "desk.app.json"),
      JSON.stringify({ name: SYMLINK_APP, capabilities: ["storage.read", "storage.write"] }),
      "utf8",
    );
    await fs.writeFile(path.join(appRoot, "dist", "index.html"), "<!doctype html><html></html>", "utf8");
    const cookie = await appCookie(SYMLINK_APP);

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "desk-storage-escape-"));
    await fs.symlink(outside, path.join(appRoot, ".storage"), "dir");

    const create = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${SYMLINK_APP}/storage/items`,
      { headers: { Cookie: cookie }, body: { escaped: true } },
    );
    expect(create.status).toBe(404);
    await expect(fs.stat(path.join(outside, "data.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("rejects symlinked app roots instead of writing outside the workspace", async () => {
    const SYMLINK_ROOT_APP = "symlink-root";
    const appRoot = path.join(
      chatArtifactsDir(home, workspaceSlug, chatId),
      `${SYMLINK_ROOT_APP}.app`,
    );
    await fs.mkdir(path.join(appRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(appRoot, "desk.app.json"),
      JSON.stringify({ name: SYMLINK_ROOT_APP, capabilities: ["storage.read", "storage.write"] }),
      "utf8",
    );
    await fs.writeFile(path.join(appRoot, "dist", "index.html"), "<!doctype html><html></html>", "utf8");
    const cookie = await appCookie(SYMLINK_ROOT_APP);

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "desk-app-root-escape-"));
    await fs.rm(appRoot, { recursive: true, force: true });
    await fs.symlink(outside, appRoot, "dir");

    const create = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${SYMLINK_ROOT_APP}/storage/items`,
      { headers: { Cookie: cookie }, body: { escaped: true } },
    );
    expect(create.status).toBe(404);
    await expect(fs.stat(path.join(outside, ".storage", "data.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(outside, { recursive: true, force: true });
    await fs.rm(appRoot, { force: true });
  });

  it("rejects POST/PUT with no body (400) but accepts explicit null as a doc", async () => {
    const cookie = await appCookie(RW_APP);
    // No body → 400.
    const noBody = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${RW_APP}/storage/items`,
      { headers: { Cookie: cookie } },
    );
    expect(noBody.status).toBe(400);

    // Explicit JSON `null` is a valid doc value.
    const nullBody = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${RW_APP}/storage/items`,
      { headers: { Cookie: cookie }, body: null },
    );
    expect(nullBody.status).toBe(201);
    const doc = nullBody.bodyJson as { id: string; doc: unknown };
    expect(doc.doc).toBeNull();
  });
});
