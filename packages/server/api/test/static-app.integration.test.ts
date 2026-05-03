import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@agent-desk/db";
import { runMigrations, queries } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId } from "@agent-desk/shared";
import { createApp, type AppOptions } from "../src/app.js";
import { issueSession, clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

// Static-serve is opt-in via DESK_SERVE_APP=1 + DESK_APP_DIST. The CLI sets
// these in published installs. This file exercises both: with the env on,
// the API serves the SPA and strips /api/* from incoming requests; with
// the env off (the existing dev path), it behaves exactly as before.

let pool: Pool;
let home: string;
let userId: string;
let dbPath: string;
let distRoot: string;

function appOpts(): AppOptions {
  return {
    pool,
    storage: { pool, home },
    runManager: createRunManager({
      pool,
      execRunFn: async () => ({ exitCode: 0 }),
    }),
    broadcastUserId: userId,
  };
}

const servers: http.Server[] = [];

function startServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = createApp(appOpts());
    server.listen(0, () => {
      servers.push(server);
      resolve(server);
    });
  });
}

function getServerPort(server: http.Server): number {
  return (server.address() as net.AddressInfo).port;
}

function fetchRaw(
  port: number,
  reqPath: string,
  init: { token?: string; method?: string } = {},
): Promise<{ status: number; contentType: string; body: string }> {
  const { token, method = "GET" } = init;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-static-app-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-static-app-home-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "static-app-test",
    passwordHash: "$2b$10$placeholder",
    email: "static@example.com",
  });

  // Stand up a fake @agent-desk/app/dist that the API can serve.
  distRoot = await fs.mkdtemp(path.join(os.tmpdir(), "desk-static-app-dist-"));
  await fs.writeFile(
    path.join(distRoot, "index.html"),
    "<!doctype html><html><body>desk-app-spa</body></html>",
  );
  await fs.mkdir(path.join(distRoot, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(distRoot, "assets", "main.js"),
    'console.log("desk-app-bundle");',
  );
  // PWA assets — the manifest needs the application/manifest+json
  // content-type or some browsers refuse the install prompt.
  await fs.writeFile(
    path.join(distRoot, "manifest.webmanifest"),
    '{"name":"Desk","start_url":"/","display":"standalone"}',
  );
});

afterEach(async () => {
  await clearSessions(pool);
  clearConnections();
});

afterAll(async () => {
  for (const s of servers) s.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  if (distRoot) await fs.rm(distRoot, { recursive: true, force: true });
  delete process.env.DESK_HOME;
  delete process.env.DESK_SERVE_APP;
  delete process.env.DESK_APP_DIST;
});

describe("static-serve when DESK_SERVE_APP=1", () => {
  it("GET / returns the SPA index.html", async () => {
    process.env.DESK_SERVE_APP = "1";
    process.env.DESK_APP_DIST = distRoot;
    const server = await startServer();
    const res = await fetchRaw(getServerPort(server), "/");
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
    expect(res.body).toContain("desk-app-spa");
  });

  it("GET /assets/main.js returns the asset with JS content-type", async () => {
    process.env.DESK_SERVE_APP = "1";
    process.env.DESK_APP_DIST = distRoot;
    const server = await startServer();
    const res = await fetchRaw(getServerPort(server), "/assets/main.js");
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/javascript/);
    expect(res.body).toContain("desk-app-bundle");
  });

  it("GET /chats/some-id falls back to index.html for SPA client routing", async () => {
    process.env.DESK_SERVE_APP = "1";
    process.env.DESK_APP_DIST = distRoot;
    const server = await startServer();
    const res = await fetchRaw(getServerPort(server), "/chats/some-id");
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
    expect(res.body).toContain("desk-app-spa");
  });

  it("GET /api/me without auth returns 401 (API still gated)", async () => {
    process.env.DESK_SERVE_APP = "1";
    process.env.DESK_APP_DIST = distRoot;
    const server = await startServer();
    const res = await fetchRaw(getServerPort(server), "/api/me");
    expect(res.status).toBe(401);
  });

  it("GET /api/me with auth returns the account payload", async () => {
    process.env.DESK_SERVE_APP = "1";
    process.env.DESK_APP_DIST = distRoot;
    const server = await startServer();
    const token = await issueSession(pool, userId);
    const res = await fetchRaw(getServerPort(server), "/api/me", { token });
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/application\/json/);
    expect(JSON.parse(res.body).id).toBe(userId);
  });

  it("GET /manifest.webmanifest returns application/manifest+json", async () => {
    process.env.DESK_SERVE_APP = "1";
    process.env.DESK_APP_DIST = distRoot;
    const server = await startServer();
    const res = await fetchRaw(getServerPort(server), "/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/application\/manifest\+json/);
    expect(JSON.parse(res.body).name).toBe("Desk");
  });

  it("path traversal attempts (/../) cannot escape distRoot", async () => {
    process.env.DESK_SERVE_APP = "1";
    process.env.DESK_APP_DIST = distRoot;
    const server = await startServer();
    // Decoded "%2e%2e/%2e%2e/etc/passwd" should fall back to index.html,
    // not return /etc/passwd.
    const res = await fetchRaw(
      getServerPort(server),
      "/%2e%2e/%2e%2e/etc/passwd",
    );
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
    expect(res.body).toContain("desk-app-spa");
  });
});

describe("default mode (DESK_SERVE_APP unset) — no behaviour change", () => {
  it("GET / still returns hello world", async () => {
    delete process.env.DESK_SERVE_APP;
    delete process.env.DESK_APP_DIST;
    const server = await startServer();
    const res = await fetchRaw(getServerPort(server), "/");
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello world");
  });

  it("GET /chats/some-id returns 401 without auth, not the SPA", async () => {
    delete process.env.DESK_SERVE_APP;
    delete process.env.DESK_APP_DIST;
    const server = await startServer();
    const res = await fetchRaw(getServerPort(server), "/chats/some-id");
    // Without static-serve, the path goes through the auth middleware
    // and is rejected as an unauthenticated API call.
    expect(res.status).toBe(401);
  });
});

describe("/api/* prefix stripping (always on)", () => {
  it("GET /api/openapi.json returns the same spec as /openapi.json", async () => {
    delete process.env.DESK_SERVE_APP;
    delete process.env.DESK_APP_DIST;
    const server = await startServer();
    const port = getServerPort(server);
    const direct = await fetchRaw(port, "/openapi.json");
    const prefixed = await fetchRaw(port, "/api/openapi.json");
    expect(direct.status).toBe(200);
    expect(prefixed.status).toBe(200);
    expect(prefixed.body).toBe(direct.body);
  });
});
