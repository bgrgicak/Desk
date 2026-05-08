/**
 * Integration tests for `.app/` directory support:
 *   - GET /library/meta returns isDir:true metadata for a .app directory
 *   - GET /apps/<wsId>/<appPath>/dist/<file> serves static files from the
 *     app's dist/ directory, authenticated via Bearer header and ?token= param.
 *   - Unauthorised requests are rejected.
 *   - Path traversal outside dist/ is blocked.
 *   - Missing files fall back to index.html (SPA client-side routing).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations, seedIfEmpty } from "@agent-desk/db";
import { createRunManager } from "@agent-desk/scheduler";
import { chatArtifactsDir, ensureLayout, ensureWorkspaceLayout } from "@agent-desk/storage";
import { generateId } from "@agent-desk/shared";
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
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-app-serving-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "apptest-user";
  process.env.DESK_SEED_PASSWORD = "apptest-pw";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-app-serving-"));
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
    [chatId, workspaceId, agentId, "App Test Chat"],
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

  const login = await req("POST", "/auth/login", undefined, {
    username: "apptest-user",
    password: "apptest-pw",
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

function req(
  method: string,
  urlPath: string,
  token?: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: unknown; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...extraHeaders };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const r = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers as Record<string, string | string[] | undefined> });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Creates a minimal .app directory tree under the chat's artifacts dir. */
async function createChatApp(appName: string): Promise<{ appPath: string; distDir: string }> {
  const artifactsDir = chatArtifactsDir(home, workspaceSlug, chatId);
  const appDir = path.join(artifactsDir, appName);
  const distDir = path.join(appDir, "dist");
  await fs.mkdir(distDir, { recursive: true });

  // Minimal dist output
  await fs.writeFile(
    path.join(distDir, "index.html"),
    `<!DOCTYPE html><html><body><h1>${appName}</h1></body></html>`,
    "utf8",
  );
  await fs.writeFile(
    path.join(distDir, "main.js"),
    `console.log("${appName}");`,
    "utf8",
  );

  // desk.app.json manifest
  await fs.writeFile(
    path.join(appDir, "desk.app.json"),
    JSON.stringify({ name: appName, displayName: appName, version: "0.1.0", capabilities: [], fragments: [] }),
    "utf8",
  );

  const appRelPath = `.chats/${chatId}/artifacts/${appName}`;
  return { appPath: appRelPath, distDir };
}

/** Creates a minimal .app directory under the workspace library root. */
async function createLibraryApp(appName: string): Promise<{ appPath: string; distDir: string }> {
  const wsRoot = path.join(home, workspaceSlug);
  const appDir = path.join(wsRoot, appName);
  const distDir = path.join(appDir, "dist");
  await fs.mkdir(distDir, { recursive: true });

  await fs.writeFile(
    path.join(distDir, "index.html"),
    `<!DOCTYPE html><html><body><h1>${appName} library</h1></body></html>`,
    "utf8",
  );
  await fs.writeFile(
    path.join(distDir, "app.css"),
    `body { font-family: sans-serif; }`,
    "utf8",
  );
  await fs.writeFile(
    path.join(appDir, "desk.app.json"),
    JSON.stringify({ name: appName, displayName: appName, version: "0.1.0", capabilities: [], fragments: [] }),
    "utf8",
  );

  return { appPath: appName, distDir };
}

describe("GET /library/meta — .app directory metadata", () => {
  it("returns isDir:true and inode/directory mime for a chat .app directory", async () => {
    const { appPath } = await createChatApp("meta-test.app");

    const res = await req(
      "GET",
      `/library/meta?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(appPath)}`,
      authToken,
    );

    expect(res.status).toBe(200);
    const body = res.body as { path: string; name: string; mime: string; isDir: boolean };
    expect(body.path).toBe(appPath);
    expect(body.name).toBe("meta-test.app");
    expect(body.isDir).toBe(true);
    expect(body.mime).toBe("inode/directory");
  });

  it("returns isDir:true for a library .app directory", async () => {
    const { appPath } = await createLibraryApp("lib-meta.app");

    const res = await req(
      "GET",
      `/library/meta?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(appPath)}`,
      authToken,
    );

    expect(res.status).toBe(200);
    const body = res.body as { isDir: boolean };
    expect(body.isDir).toBe(true);
  });

  it("still rejects non-.app directories", async () => {
    // Create a plain folder (not .app)
    const wsRoot = path.join(home, workspaceSlug);
    const plainDir = path.join(wsRoot, "plain-folder");
    await fs.mkdir(plainDir, { recursive: true });

    const res = await req(
      "GET",
      `/library/meta?workspaceId=${encodeURIComponent(workspaceId)}&path=plain-folder`,
      authToken,
    );

    expect(res.status).toBe(404);
  });
});

describe("GET /apps/<wsId>/<appPath>/dist/<file>", () => {
  it("serves index.html from a chat .app dist/ via Bearer header", async () => {
    const { appPath } = await createChatApp("bearer-test.app");
    const url = `/apps/${workspaceId}/${appPath}/dist/index.html`;

    const res = await req("GET", url, authToken);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body as string).toContain("bearer-test.app");
  });

  it("serves index.html via ?token= query param (iframe use case)", async () => {
    const { appPath } = await createChatApp("token-param-test.app");
    const url = `/apps/${workspaceId}/${appPath}/dist/index.html?token=${encodeURIComponent(authToken)}`;

    const res = await req("GET", url); // no Authorization header

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body as string).toContain("token-param-test.app");
  });

  it("serves a JS asset with correct content-type", async () => {
    const { appPath } = await createChatApp("js-asset-test.app");
    const url = `/apps/${workspaceId}/${appPath}/dist/main.js`;

    const res = await req("GET", url, authToken);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.body as string).toContain("js-asset-test.app");
  });

  it("falls back to index.html for an unknown path (SPA routing)", async () => {
    const { appPath } = await createChatApp("spa-fallback-test.app");
    const url = `/apps/${workspaceId}/${appPath}/dist/some/nested/route`;

    const res = await req("GET", url, authToken);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body as string).toContain("spa-fallback-test.app");
  });

  it("serves files from a library .app directory", async () => {
    const { appPath } = await createLibraryApp("lib-serve-test.app");
    const url = `/apps/${workspaceId}/${appPath}/dist/index.html`;

    const res = await req("GET", url, authToken);

    expect(res.status).toBe(200);
    expect(res.body as string).toContain("lib-serve-test.app library");
  });

  it("serves a CSS file from a library .app with correct content-type", async () => {
    const { appPath } = await createLibraryApp("lib-css-test.app");
    const url = `/apps/${workspaceId}/${appPath}/dist/app.css`;

    const res = await req("GET", url, authToken);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/css/);
  });

  it("returns 401 when no token is provided", async () => {
    const { appPath } = await createChatApp("unauth-test.app");
    const url = `/apps/${workspaceId}/${appPath}/dist/index.html`;

    const res = await req("GET", url); // no token at all

    expect(res.status).toBe(401);
  });

  it("returns 401 for an invalid token", async () => {
    const { appPath } = await createChatApp("bad-token-test.app");
    const url = `/apps/${workspaceId}/${appPath}/dist/index.html?token=ses_invalid`;

    const res = await req("GET", url);

    expect(res.status).toBe(401);
  });

  it("sets desk-app-token cookie when serving index.html via ?token=", async () => {
    const { appPath } = await createChatApp("cookie-set-test.app");
    const url = `/apps/${workspaceId}/${appPath}/dist/index.html?token=${encodeURIComponent(authToken)}`;

    const res = await req("GET", url);

    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join("; ") : (setCookie ?? "");
    expect(cookieHeader).toContain("desk-app-token=");
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("Path=/api/apps/");
    expect(cookieHeader).not.toContain("Max-Age");
  });

  it("authenticates sub-resource requests via desk-app-token cookie", async () => {
    const { appPath } = await createChatApp("cookie-auth-test.app");
    const jsFile = "main.js";
    const url = `/apps/${workspaceId}/${appPath}/dist/${jsFile}`;
    const cookieValue = encodeURIComponent(authToken);

    // No Authorization header, no ?token= — only the cookie
    const res = await req("GET", url, undefined, undefined, {
      Cookie: `desk-app-token=${cookieValue}`,
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
  });

  it("blocks path traversal outside dist/", async () => {
    const { appPath } = await createChatApp("traversal-test.app");
    // Attempt to escape: dist/../desk.app.json
    const escapedFile = "..%2Fdesk.app.json";
    const url = `/apps/${workspaceId}/${appPath}/dist/${escapedFile}`;

    const res = await req("GET", url, authToken);

    // Should get 403 (traversal detected) or 404 (normalised away), not 200
    expect([403, 404]).toContain(res.status);
  });

  it("returns 404 for a non-.app path", async () => {
    const url = `/apps/${workspaceId}/not-an-app-dir/dist/index.html`;

    const res = await req("GET", url, authToken);

    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid workspaceId", async () => {
    const url = `/apps/invalid-ws-id/myapp.app/dist/index.html`;

    const res = await req("GET", url, authToken);

    expect(res.status).toBe(400);
  });
});
