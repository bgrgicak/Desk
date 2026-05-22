/**
 * Verifies that files surfaced in the library listing via a local-
 * filesystem connection (virtual mount) are also readable through the
 * /library/content endpoint.
 *
 * Regression: listLibrary projected the connected host directory into the
 * listing under its `homeName` prefix, but downloadFile/statFile resolved
 * the same path against `~/Roomy/<slug>/`, so the file 404'd as soon as the
 * user clicked it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, queries } from "@roomy-ai/db";
import { runMigrations, insertSeedFixture } from "@roomy-ai/db";
import { ensureLayout } from "@roomy-ai/storage";
import { createRunManager } from "@roomy-ai/scheduler";
import { LOCAL_FILESYSTEM_PROVIDER_ID } from "@roomy-ai/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let mountSourceDir: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-vmount-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  await insertSeedFixture(pool, { username: "testuser", password: "test-pass-1234" });

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-vmount-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;

  // Host directory that will be exposed via a local-filesystem connection.
  // Sits outside the Roomy home so the test verifies the projection — not a
  // path that happens to resolve under the workspace by accident.
  mountSourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-vmount-src-"));
  await fs.writeFile(
    path.join(mountSourceDir, "pr-review.md"),
    "# PR Review\n\nfrom host directory\n",
    "utf-8",
  );

  const storage = { pool, home };
  const runManager = createRunManager({
    pool,
    execRunFn: async (_runId, _agentId, _prompt, onLog) => {
      await onLog({ runId: _runId, seq: 0, kind: "stdout", payload: "ok" });
      return { exitCode: 0 };
    },
  });

  const { rows: userRows } = await pool.query("SELECT id FROM users LIMIT 1");
  const broadcastUserId = userRows[0].id as string;

  server = createApp({ pool, storage, runManager, broadcastUserId });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await clearSessions(pool);
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (mountSourceDir) await fs.rm(mountSourceDir, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
});

function request(
  method: string,
  urlPath: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const payload = body ? JSON.stringify(body) : undefined;
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

function getRaw(
  urlPath: string,
  token: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function login(): Promise<string> {
  const loginRes = await request("POST", "/auth/login", undefined, {
    email: "testuser@roomy.local",
    password: "test-pass-1234",
  });
  return (loginRes.body as { token: string }).token;
}

async function firstWorkspaceId(token: string): Promise<string> {
  const res = await request("GET", "/workspaces", token);
  return (res.body as Array<{ id: string }>)[0].id;
}

async function firstUserId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM users LIMIT 1");
  return rows[0].id;
}

describe("library virtual-mount reads", () => {
  it("keeps active local filesystem connections hidden until granted to the workspace", async () => {
    const token = await login();
    const workspaceId = await firstWorkspaceId(token);
    const userId = await firstUserId();

    await queries.connectors.createConnection(pool, {
      ownerUserId: userId,
      providerId: LOCAL_FILESYSTEM_PROVIDER_ID,
      displayName: "Ungrafted host folder",
      capabilities: ["local_filesystem.read"],
      status: "active",
      metadata: {
        localFilesystem: {
          directories: [
            {
              id: "dir-hidden",
              hostPath: mountSourceDir,
              homeName: "HiddenHost",
              access: "read_only",
            },
          ],
        },
      },
    });

    const rootRes = await request(
      "GET",
      `/library?workspaceId=${encodeURIComponent(workspaceId)}`,
      token,
    );
    expect(rootRes.status).toBe(200);
    const rootFolders = (rootRes.body as { folders: Array<{ path: string }> }).folders;
    expect(rootFolders.some((f) => f.path === "HiddenHost")).toBe(false);
  });

  it("GET /library/content streams a file from a connected host directory", async () => {
    const token = await login();
    const workspaceId = await firstWorkspaceId(token);
    const userId = await firstUserId();

    // Wire up a local-filesystem connection + workspace grant pointing at
    // `mountSourceDir`, surfaced as `Downloads/` in the library.
    const connection = await queries.connectors.createConnection(pool, {
      ownerUserId: userId,
      providerId: LOCAL_FILESYSTEM_PROVIDER_ID,
      displayName: "Host Downloads",
      capabilities: ["local_filesystem.read", "local_filesystem.write"],
      metadata: {
        localFilesystem: {
          directories: [
            {
              id: "dir-1",
              hostPath: mountSourceDir,
              homeName: "Downloads",
              access: "read_write",
            },
          ],
        },
      },
    });
    await queries.connectors.replaceWorkspaceGrants(pool, workspaceId, userId, [
      {
        connectionId: connection.id,
        providerId: LOCAL_FILESYSTEM_PROVIDER_ID,
        grantedCapabilities: ["local_filesystem.read", "local_filesystem.write"],
      },
    ]);

    // The library listing must surface the mounted directory at the
    // workspace root, and drilling into it must yield the file.
    const rootRes = await request(
      "GET",
      `/library?workspaceId=${encodeURIComponent(workspaceId)}`,
      token,
    );
    expect(rootRes.status).toBe(200);
    const rootFolders = (rootRes.body as { folders: Array<{ path: string }> }).folders;
    expect(rootFolders.some((f) => f.path === "Downloads")).toBe(true);

    const listRes = await request(
      "GET",
      `/library?workspaceId=${encodeURIComponent(workspaceId)}&path=Downloads`,
      token,
    );
    expect(listRes.status).toBe(200);
    const items = (listRes.body as { items: Array<{ path: string }> }).items;
    expect(items.some((it) => it.path === "Downloads/pr-review.md")).toBe(true);

    // …and clicking it must return the file content, not a 404.
    const contentRes = await getRaw(
      `/library/content?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent("Downloads/pr-review.md")}`,
      token,
    );
    expect(contentRes.status).toBe(200);
    expect(contentRes.body).toBe("# PR Review\n\nfrom host directory\n");
    expect(contentRes.headers["etag"]).toBeTruthy();
  });

  it("PUT /library/content writes back into the connected host directory", async () => {
    const token = await login();
    const workspaceId = await firstWorkspaceId(token);

    const target = "Downloads/pr-review.md";
    const newBody = "# PR Review\n\nedited via API\n";
    const putRes = await new Promise<{ status: number }>((resolve, reject) => {
      const body = Buffer.from(newBody);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/library/content?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(target)}`,
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "text/plain",
            "Content-Length": String(body.length),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
    expect(putRes.status).toBe(200);

    // Round-trip via the read path and via the host filesystem — both
    // should reflect the new contents.
    const contentRes = await getRaw(
      `/library/content?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(target)}`,
      token,
    );
    expect(contentRes.status).toBe(200);
    expect(contentRes.body).toBe(newBody);

    const onDisk = await fs.readFile(path.join(mountSourceDir, "pr-review.md"), "utf-8");
    expect(onDisk).toBe(newBody);
  });

  it("GET /library/content rejects path traversal inside a virtual mount", async () => {
    const token = await login();
    const workspaceId = await firstWorkspaceId(token);

    // `Downloads/../../etc/passwd` — even though the prefix matches a
    // mount, the resolver must keep us inside the mount.
    const res = await getRaw(
      `/library/content?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent("Downloads/../../etc/passwd")}`,
      token,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
