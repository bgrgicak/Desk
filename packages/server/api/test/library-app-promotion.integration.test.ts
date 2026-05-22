/**
 * PR-E: library `<name>.app/` recognition + promote-from-chat-to-library.
 *
 * Real roomy-server, real SQLite, real fs. Creates a `<name>.app/` chat
 * artifact, promotes it via `POST /chats/:id/save-artifact-to-library`,
 * and confirms:
 *   - the source disappears from the chat artifacts dir;
 *   - the destination appears in the library list as a single item with
 *     `isDir: true` and `mime: 'application/vnd.roomy.app+directory'`;
 *   - the library walker does NOT recurse into the `.app/` directory
 *     (no node_modules / dist children leak into the listing);
 *   - `POST /apps/library/<appName>/issue` mints a session, the bootstrap
 *     URL serves the bridge-injected index.html, and sandbox subresources
 *     load without cookies.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations, insertSeedFixture } from "@roomy-ai/db";
import { createRunManager } from "@roomy-ai/scheduler";
import { generateId } from "@roomy-ai/shared";
import {
  chatArtifactsDir,
  ensureLayout,
  ensureWorkspaceLayout,
  workspaceRootPath,
} from "@roomy-ai/storage";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";
import { clearAppSessions } from "../src/routes/apps.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let workspaceId: string;
let workspaceSlug: string;
let chatId: string;
let authToken: string;

const APP_NAME = "promoter-app";

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-promote-int-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  await insertSeedFixture(pool, { username: "promote-int-user", password: "pw" });

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-promote-int-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;

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
    [chatId, wsRows[0].id, agentId, "Promote Test"],
  );

  // Materialize a built `.app/` chat artifact
  const appRoot = path.join(
    chatArtifactsDir(home, workspaceSlug, chatId),
    `${APP_NAME}.app`,
  );
  await fs.mkdir(path.join(appRoot, "dist", "assets"), { recursive: true });
  await fs.mkdir(path.join(appRoot, "node_modules", "react"), { recursive: true });
  await fs.writeFile(
    path.join(appRoot, "roomy.app.json"),
    JSON.stringify({
      name: APP_NAME,
      capabilities: ["library.read"],
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(appRoot, "dist", "index.html"),
    "<!doctype html><html><head><title>App</title></head><body><div id=\"root\"></div><script type=\"module\" src=\"./assets/index.js\"></script></body></html>",
    "utf8",
  );
  await fs.writeFile(
    path.join(appRoot, "dist", "assets", "index.js"),
    "import './chunk.js'; export const sentinel = 'LIBRARY-APP-ASSET-PROBE'",
    "utf8",
  );
  await fs.writeFile(
    path.join(appRoot, "dist", "assets", "chunk.js"),
    "export const chunkSentinel = 'LIBRARY-APP-CHUNK-PROBE'",
    "utf8",
  );
  await fs.writeFile(
    path.join(appRoot, "node_modules", "react", "package.json"),
    "{}",
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
    body: { email: "promote-int-user@roomy.local", password: "pw" },
  });
  authToken = (login.bodyJson as { token: string }).token;
});

afterAll(async () => {
  await clearAppSessions(pool);
  await clearSessions(pool);
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.ROOMY_HOME;
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

function pickSetCookie(headers: http.IncomingHttpHeaders, prefix: string): string | null {
  const raw = headers["set-cookie"] ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  for (const line of list) {
    if (typeof line !== "string") continue;
    if (!line.startsWith(prefix)) continue;
    const semi = line.indexOf(";");
    return semi === -1 ? line : line.slice(0, semi);
  }
  return null;
}

describe("library `.app/` recognition + promote-from-chat (PR-E)", () => {
  it("library list returns `<name>.app/` directories as single items with isDir:true and the app mime", async () => {
    // First, copy a plain `.app/` directly into the workspace root so
    // we can assert library walking before the promotion runs.
    const wsRoot = workspaceRootPath(home, workspaceSlug);
    await fs.mkdir(path.join(wsRoot, "preexisting-app.app", "dist"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(wsRoot, "preexisting-app.app", "roomy.app.json"),
      JSON.stringify({ name: "preexisting-app", capabilities: [] }),
      "utf8",
    );
    await fs.mkdir(
      path.join(wsRoot, "preexisting-app.app", "node_modules", "react"),
      { recursive: true },
    );

    const list = await httpRaw("GET", `/library?workspaceId=${workspaceId}`, { bearer: authToken });
    expect(list.status).toBe(200);
    const body = list.bodyJson as {
      items: Array<{ path: string; name: string; isDir?: boolean; mime: string }>;
      folders: Array<{ path: string }>;
    };
    const appItem = body.items.find((it) => it.name === "preexisting-app.app");
    expect(appItem, `expected preexisting-app.app in items`).toBeTruthy();
    expect(appItem?.isDir).toBe(true);
    expect(appItem?.mime).toBe("application/vnd.roomy.app+directory");
    // The walker must NOT have recursed — no `node_modules/react/...`
    // child entries should leak into the listing.
    expect(
      body.items.some((it) => it.path.includes("preexisting-app.app/")),
    ).toBe(false);
    expect(
      body.folders.some((f) => f.path === "preexisting-app.app"),
    ).toBe(false);
  });

  it("`POST /chats/:id/save-artifact-to-library` promotes a chat-artifact `.app/` to the library", async () => {
    // Confirm the chat artifact exists before the call
    const chatArtBefore = await fs.stat(
      path.join(chatArtifactsDir(home, workspaceSlug, chatId), `${APP_NAME}.app`),
    );
    expect(chatArtBefore.isDirectory()).toBe(true);

    const res = await httpRaw(
      "POST",
      `/chats/${chatId}/save-artifact-to-library`,
      { bearer: authToken, body: { name: `${APP_NAME}.app` } },
    );
    expect(res.status).toBe(201);
    const result = res.bodyJson as { path: string; name: string; isDir: boolean; mime: string };
    expect(result.path).toBe(`${APP_NAME}.app`);
    expect(result.isDir).toBe(true);
    expect(result.mime).toBe("application/vnd.roomy.app+directory");

    // Source should be gone
    await expect(
      fs.stat(path.join(chatArtifactsDir(home, workspaceSlug, chatId), `${APP_NAME}.app`)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Destination should be there
    const wsRoot = workspaceRootPath(home, workspaceSlug);
    const destStat = await fs.stat(path.join(wsRoot, `${APP_NAME}.app`));
    expect(destStat.isDirectory()).toBe(true);

    // Library list should now include the promoted app
    const list = await httpRaw("GET", `/library?workspaceId=${workspaceId}`, { bearer: authToken });
    const items = (list.bodyJson as {
      items: Array<{ name: string; isDir?: boolean }>;
    }).items;
    expect(items.find((i) => i.name === `${APP_NAME}.app`)?.isDir).toBe(true);
  });

  it("`POST /apps/library/<name>/issue` mints a session and the bootstrap URL serves the bridge-injected index.html", async () => {
    const issue = await httpRaw(
      "POST",
      `/apps/library/${APP_NAME}/issue`,
      { bearer: authToken },
    );
    expect(issue.status).toBe(201);
    const issued = issue.bodyJson as {
      token: string;
      url: string;
      cookieName: string;
      capabilities: string[];
    };
    expect(issued.token.startsWith("app_")).toBe(true);
    expect(issued.cookieName.startsWith("roomy_libapp_")).toBe(true);
    expect(issued.url).toMatch(new RegExp(`^/apps/library/${workspaceId}/[a-f0-9]{64}/${APP_NAME}\\.app/dist/\\?t=`));

    // Bootstrap now serves index inline (200); see apps.ts for why the
    // old 302-redirect path was killed.
    const bootstrap = await httpRaw("GET", issued.url);
    expect(bootstrap.status, bootstrap.body).toBe(200);
    const cookie = pickSetCookie(bootstrap.headers, issued.cookieName);
    expect(cookie).toBeTruthy();

    const setCookie = String(bootstrap.headers["set-cookie"]?.[0] ?? "");
    const cookiePath = /Path=([^;]+)/.exec(setCookie)?.[1] ?? "";
    const issuedPath = issued.url.split("?")[0];
    expect(issuedPath.startsWith(cookiePath)).toBe(true);

    expect(bootstrap.body).toContain("window.roomy");
    expect(bootstrap.body).toContain(`"name":"${APP_NAME}"`);
    expect(bootstrap.body).toContain('./assets/index.js');
    // Library scope: chatId is the empty string in the bridge payload so
    // app code can branch on whether it's running standalone or in a
    // chat context.
    expect(bootstrap.body).toContain('"chatId":""');
  });

  it("issues and serves a nested library app from the requested workspace path", async () => {
    const wsRoot = workspaceRootPath(home, workspaceSlug);
    const nestedAppPath = "Projects/Q2/nested-app.app";
    const nestedAppRoot = path.join(wsRoot, nestedAppPath);
    await fs.mkdir(path.join(nestedAppRoot, "dist", "fragments", "list"), { recursive: true });
    await fs.writeFile(
      path.join(nestedAppRoot, "roomy.app.json"),
      JSON.stringify({ name: "nested-app", capabilities: [] }),
      "utf8",
    );
    await fs.writeFile(
      path.join(nestedAppRoot, "dist", "index.html"),
      "<!doctype html><html><head></head><body>Nested app root</body></html>",
      "utf8",
    );
    await fs.writeFile(
      path.join(nestedAppRoot, "dist", "fragments", "list", "index.html"),
      "<!doctype html><html><head></head><body>Nested fragment</body></html>",
      "utf8",
    );

    const issue = await httpRaw(
      "POST",
      `/apps/library/nested-app/issue?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(nestedAppPath)}`,
      { bearer: authToken },
    );

    expect(issue.status).toBe(201);
    const issued = issue.bodyJson as { url: string; cookieName: string };
    expect(issued.url).toMatch(new RegExp(`^/apps/library/${workspaceId}/[a-f0-9]{64}/Projects/Q2/nested-app\\.app/dist/\\?t=`));

    const fragmentUrl = issued.url.replace("/dist/", "/dist/fragments/list/");
    const bootstrap = await httpRaw("GET", fragmentUrl);
    expect(bootstrap.status, bootstrap.body).toBe(200);
    const cookie = pickSetCookie(bootstrap.headers, issued.cookieName);
    expect(cookie).toBeTruthy();
    const setCookie = String(bootstrap.headers["set-cookie"]?.[0] ?? "");
    const cookiePath = /Path=([^;]+)/.exec(setCookie)?.[1] ?? "";
    expect(fragmentUrl.split("?")[0].startsWith(cookiePath)).toBe(true);

    // Bootstrap response is the fragment HTML inline (no 302 round-trip).
    expect(bootstrap.body).toContain("Nested fragment");
    expect(bootstrap.body).toContain("window.roomy");
  });

  it("serves library app JS assets without cookies for opaque sandbox subresource loads", async () => {
    const issue = await httpRaw(
      "POST",
      `/apps/library/${APP_NAME}/issue`,
      { bearer: authToken },
    );
    const issued = issue.bodyJson as { url: string };
    // Bootstrap now serves 200 inline, so derive the asset root from the
    // issued URL (strip the `?t=` query) rather than the removed Location.
    await httpRaw("GET", issued.url);
    const issuedPath = issued.url.split("?")[0];
    const assetRootMatch = issuedPath.match(new RegExp(`^(/apps/library/${workspaceId}/[a-f0-9]{64}/${APP_NAME}\\.app/dist/)`));
    expect(assetRootMatch).toBeTruthy();
    const assetRoot = assetRootMatch![1];

    const asset = await httpRaw(
      "GET",
      `${assetRoot}assets/index.js`,
    );

    expect(asset.status).toBe(200);
    expect(asset.body).toContain("LIBRARY-APP-ASSET-PROBE");
    expect(asset.headers["content-type"]).toContain("application/javascript");
    expect(asset.headers["access-control-allow-origin"]).toBe("*");

    const chunk = await httpRaw(
      "GET",
      `${assetRoot}assets/chunk.js`,
    );
    expect(chunk.status).toBe(200);
    expect(chunk.body).toContain("LIBRARY-APP-CHUNK-PROBE");

    const noAssetToken = await httpRaw(
      "GET",
      `/apps/library/${workspaceId}/${APP_NAME}/dist/assets/index.js`,
    );
    expect(noAssetToken.status).toBe(401);
  });

  it("rejects promotion of non-`.app` artifacts", async () => {
    const res = await httpRaw(
      "POST",
      `/chats/${chatId}/save-artifact-to-library`,
      { bearer: authToken, body: { name: "not-an-app" } },
    );
    expect([400, 404]).toContain(res.status);
  });

  it("deletes a chat-artifact `<name>.app/` and revokes its app_sessions", async () => {
    // Set up a fresh chat-artifact app + session for this test.
    const DELETE_NAME = "to-be-deleted";
    const appRoot = path.join(
      chatArtifactsDir(home, workspaceSlug, chatId),
      `${DELETE_NAME}.app`,
    );
    await fs.mkdir(path.join(appRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(appRoot, "roomy.app.json"),
      JSON.stringify({ name: DELETE_NAME, capabilities: [] }),
      "utf8",
    );

    // Issue a session so we have a row to assert is revoked.
    const issue = await httpRaw(
      "POST",
      `/apps/chat/${chatId}/${DELETE_NAME}/issue`,
      { bearer: authToken },
    );
    expect(issue.status).toBe(201);

    // Delete the app.
    const del = await httpRaw(
      "DELETE",
      `/apps/chat/${chatId}/${DELETE_NAME}`,
      { bearer: authToken },
    );
    expect(del.status).toBe(200);

    // Directory is gone.
    await expect(fs.stat(appRoot)).rejects.toMatchObject({ code: "ENOENT" });

    // Sessions for this app are gone (cookie can't be reused).
    const { rows } = await pool.query<{ count: number }>(
      "SELECT COUNT(*) as count FROM app_sessions WHERE chat_id = ? AND app_name = ?",
      [chatId, DELETE_NAME],
    );
    expect(rows[0].count).toBe(0);
  });

  it("deletes a library `<name>.app/` (moves it to .trash) and revokes its app_sessions", async () => {
    const DELETE_NAME = "lib-to-delete";
    const wsRoot = workspaceRootPath(home, workspaceSlug);
    const appRoot = path.join(wsRoot, `${DELETE_NAME}.app`);
    await fs.mkdir(path.join(appRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(appRoot, "roomy.app.json"),
      JSON.stringify({ name: DELETE_NAME, capabilities: [] }),
      "utf8",
    );

    const issue = await httpRaw(
      "POST",
      `/apps/library/${DELETE_NAME}/issue`,
      { bearer: authToken },
    );
    expect(issue.status).toBe(201);

    const del = await httpRaw(
      "DELETE",
      `/apps/library/${DELETE_NAME}`,
      { bearer: authToken },
    );
    expect(del.status).toBe(200);

    // The library copy is gone from the workspace root…
    await expect(fs.stat(appRoot)).rejects.toMatchObject({ code: "ENOENT" });

    // …but a backup landed in .trash/.app-versions/.
    const versionsRoot = path.join(home, ".trash", ".app-versions");
    const trashEntries = await fs.readdir(versionsRoot);
    expect(
      trashEntries.find((e) => e.startsWith(`${DELETE_NAME}.app-`)),
    ).toBeTruthy();

    // Library-scope sessions for this app are revoked.
    const { rows } = await pool.query<{ count: number }>(
      "SELECT COUNT(*) as count FROM app_sessions WHERE scope = 'library' AND app_name = ?",
      [DELETE_NAME],
    );
    expect(rows[0].count).toBe(0);
  });
});
