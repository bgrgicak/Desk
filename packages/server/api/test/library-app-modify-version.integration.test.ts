/**
 * Modify-as-version flow for library apps.
 *
 * Real roomy-server, real SQLite, real fs. Walks the full flow:
 *   1. Materialize a library `<name>.app/`.
 *   2. `POST /chats/:id/copy-library-app` clones it into the chat's
 *      artifacts dir (with node_modules and dist intact).
 *   3. Mutate the chat copy.
 *   4. `POST /chats/:id/replace-library-app` swaps it back into the
 *      library; the prior library copy lands under
 *      `~/.trash/.app-versions/`.
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
  ensureLayout,
  ensureWorkspaceLayout,
  workspaceRootPath,
  chatArtifactsDir,
} from "@roomy-ai/storage";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let workspaceSlug: string;
let chatId: string;
let authToken: string;

const APP_NAME = "versioned-app";

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-modver-int-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  await insertSeedFixture(pool, { username: "modver-int-user", password: "pw" });

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-modver-int-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;

  const { rows: wsRows } = await pool.query<{ id: string; path: string }>(
    "SELECT id, path FROM workspaces LIMIT 1",
  );
  workspaceSlug = wsRows[0].path;
  await ensureWorkspaceLayout(home, workspaceSlug);

  const { rows: agentRows } = await pool.query<{ id: string }>("SELECT id FROM agents LIMIT 1");
  chatId = generateId("chat");
  await pool.query(
    "INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)",
    [chatId, wsRows[0].id, agentRows[0].id, "Modify-As-Version Test"],
  );

  // Materialize the library `.app/` (v1 manifest content)
  const wsRoot = workspaceRootPath(home, workspaceSlug);
  const appRoot = path.join(wsRoot, `${APP_NAME}.app`);
  await fs.mkdir(path.join(appRoot, "dist"), { recursive: true });
  await fs.mkdir(path.join(appRoot, "node_modules"), { recursive: true });
  await fs.writeFile(
    path.join(appRoot, "roomy.app.json"),
    JSON.stringify({ name: APP_NAME, version: "0.1.0", capabilities: [] }),
    "utf8",
  );
  await fs.writeFile(
    path.join(appRoot, "dist", "index.html"),
    "<!doctype html><html><head></head><body>v1</body></html>",
    "utf8",
  );
  await fs.writeFile(
    path.join(appRoot, "node_modules", "marker.txt"),
    "preserved",
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
    body: { email: "modver-int-user@roomy.local", password: "pw" },
  });
  authToken = (login.bodyJson as { token: string }).token;
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

describe("modify-as-version flow", () => {
  it("`POST /chats/:id/copy-library-app` clones the library `<name>.app/` into the chat artifacts dir", async () => {
    const res = await httpRaw(
      "POST",
      `/chats/${chatId}/copy-library-app`,
      { bearer: authToken, body: { path: `${APP_NAME}.app` } },
    );
    expect(res.status).toBe(201);
    const ref = res.bodyJson as { path: string; name: string; isDir: boolean };
    expect(ref.path).toBe(`.chats/${chatId}/artifacts/${APP_NAME}.app`);
    expect(ref.name).toBe(`${APP_NAME}.app`);
    expect(ref.isDir).toBe(true);

    // The cloned tree should carry node_modules and dist
    const chatAppDir = path.join(
      chatArtifactsDir(home, workspaceSlug, chatId),
      `${APP_NAME}.app`,
    );
    const distContent = await fs.readFile(
      path.join(chatAppDir, "dist", "index.html"),
      "utf8",
    );
    expect(distContent).toContain("v1");
    const nmContent = await fs.readFile(
      path.join(chatAppDir, "node_modules", "marker.txt"),
      "utf8",
    );
    expect(nmContent).toBe("preserved");

    // Original library copy still there
    const wsRoot = workspaceRootPath(home, workspaceSlug);
    const libDistContent = await fs.readFile(
      path.join(wsRoot, `${APP_NAME}.app`, "dist", "index.html"),
      "utf8",
    );
    expect(libDistContent).toContain("v1");
  });

  it("refuses to clobber an existing chat artifact with the same name", async () => {
    const res = await httpRaw(
      "POST",
      `/chats/${chatId}/copy-library-app`,
      { bearer: authToken, body: { path: `${APP_NAME}.app` } },
    );
    expect(res.status).toBe(400);
  });

  it("`POST /chats/:id/replace-library-app` promotes the chat copy back over the library, backing up the prior version", async () => {
    // Mutate the chat copy to v2 so the replacement is observable
    const chatAppDir = path.join(
      chatArtifactsDir(home, workspaceSlug, chatId),
      `${APP_NAME}.app`,
    );
    await fs.writeFile(
      path.join(chatAppDir, "dist", "index.html"),
      "<!doctype html><html><head></head><body>v2</body></html>",
      "utf8",
    );

    const res = await httpRaw(
      "POST",
      `/chats/${chatId}/replace-library-app`,
      {
        bearer: authToken,
        body: { name: `${APP_NAME}.app`, targetPath: `${APP_NAME}.app` },
      },
    );
    expect(res.status).toBe(200);
    const ref = res.bodyJson as { path: string; name: string };
    expect(ref.path).toBe(`${APP_NAME}.app`);
    expect(ref.name).toBe(`${APP_NAME}.app`);

    // Library copy is now v2
    const wsRoot = workspaceRootPath(home, workspaceSlug);
    const newLib = await fs.readFile(
      path.join(wsRoot, `${APP_NAME}.app`, "dist", "index.html"),
      "utf8",
    );
    expect(newLib).toContain("v2");

    // Chat copy is gone (moved into the library)
    await expect(fs.stat(chatAppDir)).rejects.toMatchObject({ code: "ENOENT" });

    // Prior version preserved under .trash/.app-versions
    const versionsRoot = path.join(home, ".trash", ".app-versions");
    const versions = await fs.readdir(versionsRoot);
    expect(versions.length).toBeGreaterThan(0);
    const backupDir = versions.find((v) => v.startsWith(`${APP_NAME}.app-`));
    expect(backupDir, `expected a backup under .app-versions: ${versions}`).toBeTruthy();
    const backupContent = await fs.readFile(
      path.join(versionsRoot, backupDir!, "dist", "index.html"),
      "utf8",
    );
    expect(backupContent).toContain("v1");
  });

  it("returns a 409 conflict when the library copy moved since copy time", async () => {
    const wsRoot = workspaceRootPath(home, workspaceSlug);
    const lib = path.join(wsRoot, "concurrent.app");
    await fs.mkdir(path.join(lib, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(lib, "roomy.app.json"),
      JSON.stringify({ name: "concurrent", capabilities: [] }),
      "utf8",
    );

    const copy = await httpRaw(
      "POST",
      `/chats/${chatId}/copy-library-app`,
      { bearer: authToken, body: { path: "concurrent.app" } },
    );
    expect(copy.status).toBe(201);
    const copyBody = copy.bodyJson as { sourceVersion: string };
    expect(typeof copyBody.sourceVersion).toBe("string");

    const chatApp = path.join(
      chatArtifactsDir(home, workspaceSlug, chatId),
      "concurrent.app",
    );
    await fs.writeFile(
      path.join(chatApp, "dist", "index.html"),
      "<!doctype html><html><body>v2-from-chat</body></html>",
      "utf8",
    );

    // Simulate concurrent edit: someone touches the library copy's
    // manifest, advancing its mtime past the captured sourceVersion.
    await new Promise((r) => setTimeout(r, 10));
    const newMtime = new Date(Date.now() + 5_000);
    await fs.utimes(path.join(lib, "roomy.app.json"), newMtime, newMtime);

    const replace = await httpRaw(
      "POST",
      `/chats/${chatId}/replace-library-app`,
      {
        bearer: authToken,
        body: {
          name: "concurrent.app",
          targetPath: "concurrent.app",
          expectedSourceVersion: copyBody.sourceVersion,
        },
      },
    );
    expect(replace.status).toBe(409);
    const conflictBody = replace.bodyJson as {
      code: string;
      expected: string;
      actual: string;
    };
    expect(conflictBody.code).toBe("VERSION_CONFLICT");
    expect(conflictBody.expected).toBe(copyBody.sourceVersion);

    // Both copies still exist.
    expect((await fs.stat(chatApp)).isDirectory()).toBe(true);
    expect((await fs.stat(lib)).isDirectory()).toBe(true);

    await fs.rm(chatApp, { recursive: true, force: true });
    await fs.rm(lib, { recursive: true, force: true });
  });

  it("prunes .app-versions older than 30 days when a replace runs", async () => {
    // Stage an old backup directly under .trash/.app-versions/.
    const versionsRoot = path.join(home, ".trash", ".app-versions");
    await fs.mkdir(versionsRoot, { recursive: true });
    const oldBackup = path.join(versionsRoot, "old-version.app-2025-12-01");
    await fs.mkdir(oldBackup, { recursive: true });
    await fs.writeFile(path.join(oldBackup, "marker"), "old", "utf8");
    const ago = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldBackup, ago, ago);

    const wsRoot = workspaceRootPath(home, workspaceSlug);
    const sweepApp = path.join(wsRoot, "sweep.app");
    await fs.mkdir(path.join(sweepApp, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(sweepApp, "roomy.app.json"),
      JSON.stringify({ name: "sweep", capabilities: [] }),
      "utf8",
    );
    const copy = await httpRaw(
      "POST",
      `/chats/${chatId}/copy-library-app`,
      { bearer: authToken, body: { path: "sweep.app" } },
    );
    expect(copy.status).toBe(201);

    const replace = await httpRaw(
      "POST",
      `/chats/${chatId}/replace-library-app`,
      { bearer: authToken, body: { name: "sweep.app", targetPath: "sweep.app" } },
    );
    expect(replace.status).toBe(200);

    // Old entry pruned, new backup retained.
    await expect(fs.stat(oldBackup)).rejects.toMatchObject({ code: "ENOENT" });
    const remaining = await fs.readdir(versionsRoot);
    expect(remaining.find((n) => n.startsWith("sweep.app-"))).toBeTruthy();

    await fs.rm(sweepApp, { recursive: true, force: true });
    await fs.rm(versionsRoot, { recursive: true, force: true });
  });

  it("rejects hidden workspace paths as library copy/replace targets", async () => {
    const hiddenApp = path.join(
      chatArtifactsDir(home, workspaceSlug, chatId),
      "hidden-source.app",
    );
    await fs.mkdir(hiddenApp, { recursive: true });
    await fs.writeFile(
      path.join(hiddenApp, "roomy.app.json"),
      JSON.stringify({ name: "hidden-source", capabilities: [] }),
      "utf8",
    );

    const copyHidden = await httpRaw(
      "POST",
      `/chats/${chatId}/copy-library-app`,
      {
        bearer: authToken,
        body: { path: `.chats/${chatId}/artifacts/hidden-source.app` },
      },
    );
    expect(copyHidden.status).toBe(400);

    const targetHiddenSource = path.join(
      chatArtifactsDir(home, workspaceSlug, chatId),
      "target-hidden.app",
    );
    await fs.mkdir(targetHiddenSource, { recursive: true });
    await fs.writeFile(
      path.join(targetHiddenSource, "roomy.app.json"),
      JSON.stringify({ name: "target-hidden", capabilities: [] }),
      "utf8",
    );

    const replaceHiddenTarget = await httpRaw(
      "POST",
      `/chats/${chatId}/replace-library-app`,
      {
        bearer: authToken,
        body: {
          name: "target-hidden.app",
          targetPath: `.chats/${chatId}/artifacts/target-hidden.app`,
        },
      },
    );
    expect(replaceHiddenTarget.status).toBe(400);

    await fs.rm(hiddenApp, { recursive: true, force: true });
    await fs.rm(targetHiddenSource, { recursive: true, force: true });
  });

  it("rejects path-like chat artifact names when replacing a library app", async () => {
    const res = await httpRaw(
      "POST",
      `/chats/${chatId}/replace-library-app`,
      {
        bearer: authToken,
        body: { name: "../escape.app", targetPath: "escape.app" },
      },
    );
    expect(res.status).toBe(400);

    const backslash = await httpRaw(
      "POST",
      `/chats/${chatId}/replace-library-app`,
      {
        bearer: authToken,
        body: { name: "..\\escape.app", targetPath: "escape.app" },
      },
    );
    expect(backslash.status).toBe(400);
  });

  it("rejects symlinked library app roots when copying into chat", async () => {
    const wsRoot = workspaceRootPath(home, workspaceSlug);
    const realApp = path.join(wsRoot, "real-symlink-source.app");
    const symlinkApp = path.join(wsRoot, "symlink-source.app");
    await fs.mkdir(realApp, { recursive: true });
    await fs.writeFile(
      path.join(realApp, "roomy.app.json"),
      JSON.stringify({ name: "real-symlink-source", capabilities: [] }),
      "utf8",
    );
    await fs.symlink(realApp, symlinkApp, "dir");

    const res = await httpRaw(
      "POST",
      `/chats/${chatId}/copy-library-app`,
      { bearer: authToken, body: { path: "symlink-source.app" } },
    );
    expect(res.status).toBe(400);

    await fs.rm(symlinkApp, { force: true });
    await fs.rm(realApp, { recursive: true, force: true });
  });

  it("rejects copy + replace when the source chat artifact isn't a `.app/` directory", async () => {
    // Source chat artifact missing
    const replaceMissing = await httpRaw(
      "POST",
      `/chats/${chatId}/replace-library-app`,
      {
        bearer: authToken,
        body: { name: "no-such-app.app", targetPath: "no-such-app.app" },
      },
    );
    expect(replaceMissing.status).toBe(404);

    // copy from a non-`.app` library path
    const wsRoot = workspaceRootPath(home, workspaceSlug);
    await fs.mkdir(path.join(wsRoot, "Plain"), { recursive: true });
    const copyPlain = await httpRaw(
      "POST",
      `/chats/${chatId}/copy-library-app`,
      { bearer: authToken, body: { path: "Plain" } },
    );
    expect(copyPlain.status).toBe(400);
  });
});
