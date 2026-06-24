/**
 * PR-F: pin a library `<name>.app/` to a chat as an attachment.
 *
 * Real roomy-server, real SQLite, real fs. Materializes a library
 * `<name>.app/`, calls `POST /chats/:id/library-refs` to pin it as a
 * chat attachment, and confirms a symlink lands in the chat's
 * `attachments/` dir + the listing returns the entry with the app mime
 * + isDir flag so the client can render it as an inline AppPreview.
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
  chatAttachmentsDir,
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

const APP_NAME = "embed-target-app";

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-attach-int-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  await insertSeedFixture(pool, { username: "attach-int-user", password: "pw" });

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-attach-int-"));
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
    [chatId, wsRows[0].id, agentRows[0].id, "Embed Test"],
  );

  // Materialize a library `.app/`
  const wsRoot = workspaceRootPath(home, workspaceSlug);
  const appRoot = path.join(wsRoot, `${APP_NAME}.app`);
  await fs.mkdir(path.join(appRoot, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(appRoot, "roomy.app.json"),
    JSON.stringify({ name: APP_NAME, capabilities: [] }),
    "utf8",
  );
  await fs.writeFile(
    path.join(appRoot, "dist", "index.html"),
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
    body: { email: "attach-int-user@roomy.local", password: "pw" },
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

describe("chat-message embedding for library apps (PR-F)", () => {
  it("`POST /chats/:id/library-refs` symlinks a `<name>.app/` library directory into the chat's attachments dir", async () => {
    const res = await httpRaw(
      "POST",
      `/chats/${chatId}/library-refs`,
      { bearer: authToken, body: { path: `${APP_NAME}.app` } },
    );
    expect(res.status).toBe(201);
    const ref = res.bodyJson as { path: string; mime: string; isDir: boolean; name: string };
    expect(ref.name).toBe(`${APP_NAME}.app`);
    expect(ref.isDir).toBe(true);
    expect(ref.mime).toBe("application/vnd.roomy.app+directory");
    expect(ref.path).toBe(`.chats/${chatId}/attachments/${APP_NAME}.app`);

    // Symlink should now exist in the chat attachments dir
    const linkPath = path.join(
      await chatAttachmentsDir(home, workspaceSlug, chatId),
      `${APP_NAME}.app`,
    );
    const lstat = await fs.lstat(linkPath);
    expect(lstat.isSymbolicLink()).toBe(true);
  });

  it("rejects pinning of a non-app library directory (no semantics today)", async () => {
    const wsRoot = workspaceRootPath(home, workspaceSlug);
    await fs.mkdir(path.join(wsRoot, "Plain"), { recursive: true });
    await fs.writeFile(path.join(wsRoot, "Plain", "x.txt"), "x", "utf8");

    const res = await httpRaw(
      "POST",
      `/chats/${chatId}/library-refs`,
      { bearer: authToken, body: { path: "Plain" } },
    );
    expect(res.status).toBe(400);
  });

  it("does not list attachment symlinks that resolve outside the workspace", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-attach-outside-"));
    await fs.writeFile(path.join(outside, "secret.txt"), "do not list", "utf8");
    const attDir = await chatAttachmentsDir(home, workspaceSlug, chatId);
    const linkPath = path.join(attDir, "outside-secret.txt");
    await fs.symlink(path.join(outside, "secret.txt"), linkPath);

    const listed = await httpRaw(
      "GET",
      `/chats/${chatId}/attachments`,
      { bearer: authToken },
    );
    expect(listed.status).toBe(200);
    const names = (listed.bodyJson as Array<{ name: string }>).map((item) => item.name);
    expect(names).not.toContain("outside-secret.txt");

    await fs.unlink(linkPath);
    await fs.rm(outside, { recursive: true, force: true });
  });
});
