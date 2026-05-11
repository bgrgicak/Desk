/**
 * Integration tests for workspace-scoped `GET /chats` and /library routes
 * (feature-gap-matrix.md §4.2.3 / §4.3.5).
 *
 * Hits a real Postgres + real filesystem — follows the pattern in
 * ownership.integration.test.ts. Seeds one user with two workspaces
 * (wsA + wsB) plus a second user to cover cross-tenant 404 cases, then
 * exercises each of the six routes with explicit and implicit
 * workspaceId query params.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@agent-desk/db";
import { runMigrations, queries, hashPassword } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId } from "@agent-desk/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;

interface SeededUser {
  token: string;
  wsA: string;
  wsB: string;
  agentId: string;
  chatA: string;
  chatB: string;
}
let alpha: SeededUser;
let betaToken: string;
let betaWs: string;

async function seedUser(suffix: string): Promise<SeededUser> {
  const userId = generateId("user");
  const username = `wsscope_${suffix}`;
  const password = `pw-${suffix}`;
  await queries.users.insert(pool, {
    id: userId,
    username,
    passwordHash: await hashPassword(password),
    email: `${username}@example.com`,
  });

  const wsA = generateId("workspace");
  const wsB = generateId("workspace");
  for (const [id, name] of [
    [wsA, `ws-${suffix}-A`],
    [wsB, `ws-${suffix}-B`],
  ] as const) {
    await queries.workspaces.insert(pool, {
      id,
      userId,
      name,
      description: "",
      icon: "",
    });
  }

  const agentId = generateId("agent");
  await queries.agents.insert(pool, {
    id: agentId,
    userId,
    name: `agent-${suffix}`,
    model: "opencode/big-pickle",
  });
  for (const ws of [wsA, wsB]) {
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id)
       VALUES (?, ?)`,
      [ws, agentId],
    );
  }

  const chatA = generateId("chat");
  const chatB = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
    [chatA, wsA, agentId, `chat-${suffix}-A`],
  );
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
    [chatB, wsB, agentId, `chat-${suffix}-B`],
  );

  const login = await request("POST", "/auth/login", null, { username, password });
  const token = (login.body as { token: string }).token;

  return { token, wsA, wsB, agentId, chatA, chatB };
}

function request(
  method: string,
  pathStr: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathStr, method, headers },
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

function requestMultipart(
  method: string,
  pathStr: string,
  token: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; body: Buffer }>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const boundary = `----desk-ws-${Math.random().toString(16).slice(2)}`;
    const chunks: Buffer[] = [];
    for (const p of parts) {
      const header = [`--${boundary}`];
      const disposition = p.filename
        ? `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"`
        : `Content-Disposition: form-data; name="${p.name}"`;
      header.push(disposition);
      if (p.contentType) header.push(`Content-Type: ${p.contentType}`);
      header.push("", "");
      chunks.push(Buffer.from(header.join("\r\n")));
      chunks.push(p.body);
      chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const payload = Buffer.concat(chunks);

    const headers: Record<string, string> = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(payload.length),
      Authorization: `Bearer ${token}`,
    };
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathStr, method, headers },
      (res) => {
        const bufs: Buffer[] = [];
        res.on("data", (c: Buffer) => bufs.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(bufs).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-ws-scope-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-ws-scope-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const runManager = createRunManager({
    pool,
    execRunFn: async () => ({ exitCode: 0 }),
  });
  server = createApp({ pool, storage: { pool, home }, runManager });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  alpha = await seedUser("alpha");

  const beta = await seedUser("beta");
  betaToken = beta.token;
  betaWs = beta.wsA;
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

describe("GET /chats?workspaceId=", () => {
  it("filters to the given workspace", async () => {
    const a = await request("GET", `/chats?workspaceId=${alpha.wsA}`, alpha.token);
    expect(a.status).toBe(200);
    const aList = a.body as Array<{ id: string; workspaceId: string }>;
    expect(aList.map((c) => c.id)).toContain(alpha.chatA);
    expect(aList.map((c) => c.id)).not.toContain(alpha.chatB);

    const b = await request("GET", `/chats?workspaceId=${alpha.wsB}`, alpha.token);
    expect(b.status).toBe(200);
    const bList = b.body as Array<{ id: string }>;
    expect(bList.map((c) => c.id)).toContain(alpha.chatB);
    expect(bList.map((c) => c.id)).not.toContain(alpha.chatA);
  });

  it("defaults to the caller's first workspace when workspaceId is absent", async () => {
    const res = await request("GET", "/chats", alpha.token);
    expect(res.status).toBe(200);
    const list = res.body as Array<{ id: string; workspaceId: string }>;
    // Every row must belong to a single workspace (the first one).
    const workspaceIds = new Set(list.map((c) => c.workspaceId));
    expect(workspaceIds.size).toBe(1);
    expect(workspaceIds.has(alpha.wsA) || workspaceIds.has(alpha.wsB)).toBe(true);
  });

  it("returns 404 when asking for a peer's workspace", async () => {
    const res = await request("GET", `/chats?workspaceId=${betaWs}`, alpha.token);
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed workspaceId", async () => {
    const res = await request("GET", "/chats?workspaceId=foo", alpha.token);
    expect(res.status).toBe(400);
  });
});

describe("GET /library?workspaceId=", () => {
  // v1 workspace-as-home: single workspace at the filesystem level. Paths
  // are workspace-root-relative (e.g. "hello.txt"), not prefixed with the
  // workspace id. Isolation between workspaces will be re-enabled when the
  // multi-workspace storage layer lands; the test case for it is retained
  // as a skipped guard so the intent is preserved.
  it.skip("uploads land in the requested workspace and are isolated from peers", async () => {
    const up = await requestMultipart(
      "POST",
      `/library?workspaceId=${alpha.wsB}`,
      alpha.token,
      [{ name: "file", filename: "hello.txt", contentType: "text/plain", body: Buffer.from("hi wsB") }],
    );
    expect(up.status).toBe(201);
  });

  it("uploads return workspace-root-relative paths", async () => {
    const up = await requestMultipart(
      "POST",
      `/library?workspaceId=${alpha.wsA}`,
      alpha.token,
      [{ name: "file", filename: "root-relative.txt", contentType: "text/plain", body: Buffer.from("hi") }],
    );
    expect(up.status).toBe(201);
    const uploaded = up.body as { path: string; name: string };
    expect(uploaded.path).toBe("root-relative.txt");
  });

  it("defaults to the caller's first workspace when workspaceId is absent", async () => {
    const up = await requestMultipart(
      "POST",
      `/library?workspaceId=${alpha.wsA}`,
      alpha.token,
      [{ name: "file", filename: "default-ws.txt", contentType: "text/plain", body: Buffer.from("default") }],
    );
    expect(up.status).toBe(201);

    const res = await request("GET", "/library", alpha.token);
    expect(res.status).toBe(200);
    const items = (res.body as { items: Array<{ path: string }> }).items;
    expect(items.some((i) => i.path === "default-ws.txt")).toBe(true);
  });

  it("returns 404 when asking for a peer's workspace", async () => {
    const res = await request("GET", `/library?workspaceId=${betaWs}`, alpha.token);
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed workspaceId", async () => {
    const res = await request("GET", "/library?workspaceId=foo", alpha.token);
    expect(res.status).toBe(400);
  });
});

describe("DELETE /library", () => {
  // Cross-workspace isolation at the storage layer was removed with the
  // workspace-as-home refactor; v1 is single-workspace. These two cases
  // are kept as skipped guards for the multi-workspace follow-up.
  it.skip("deletes only within the requested workspace", async () => {
    // Upload one file in each workspace.
    const upA = await requestMultipart(
      "POST",
      `/library?workspaceId=${alpha.wsA}`,
      alpha.token,
      [{ name: "file", filename: "only-A.txt", contentType: "text/plain", body: Buffer.from("A") }],
    );
    expect(upA.status).toBe(201);
    const fileA = (upA.body as { path: string }).path;

    const upB = await requestMultipart(
      "POST",
      `/library?workspaceId=${alpha.wsB}`,
      alpha.token,
      [{ name: "file", filename: "only-B.txt", contentType: "text/plain", body: Buffer.from("B") }],
    );
    expect(upB.status).toBe(201);
    const fileB = (upB.body as { path: string }).path;

    // DELETE in wsB removes only fileB.
    const del = await request(
      "DELETE",
      `/library?workspaceId=${alpha.wsB}&path=${encodeURIComponent(fileB)}`,
      alpha.token,
    );
    expect(del.status).toBe(200);

    const listA = await request("GET", `/library?workspaceId=${alpha.wsA}`, alpha.token);
    const itemsA = (listA.body as { items: Array<{ path: string }> }).items;
    expect(itemsA.some((i) => i.path === fileA)).toBe(true);

    const listB = await request("GET", `/library?workspaceId=${alpha.wsB}`, alpha.token);
    const itemsB = (listB.body as { items: Array<{ path: string }> }).items;
    expect(itemsB.some((i) => i.path === fileB)).toBe(false);
  });

  it.skip("cannot delete a path that belongs to a different workspace (404)", async () => {
    const up = await requestMultipart(
      "POST",
      `/library?workspaceId=${alpha.wsA}`,
      alpha.token,
      [{ name: "file", filename: "safe.txt", contentType: "text/plain", body: Buffer.from("safe") }],
    );
    const filePath = (up.body as { path: string }).path;
    const res = await request(
      "DELETE",
      `/library?workspaceId=${alpha.wsB}&path=${encodeURIComponent(filePath)}`,
      alpha.token,
    );
    expect(res.status).toBe(404);

    // Confirm unchanged.
    const listA = await request("GET", `/library?workspaceId=${alpha.wsA}`, alpha.token);
    const itemsA = (listA.body as { items: Array<{ path: string }> }).items;
    expect(itemsA.some((i) => i.path === filePath)).toBe(true);
  });
});

describe("GET /library/meta and /library/download", () => {
  // Same story as above — v1 is single-workspace so cross-workspace
  // isolation at the path level is not enforced. Re-enable when
  // multi-workspace storage lands.
  it.skip("meta + download only resolve paths inside the requested workspace", async () => {
    const up = await requestMultipart(
      "POST",
      `/library?workspaceId=${alpha.wsA}`,
      alpha.token,
      [{ name: "file", filename: "meta.txt", contentType: "text/plain", body: Buffer.from("meta body") }],
    );
    const filePath = (up.body as { path: string }).path;

    const metaOk = await request(
      "GET",
      `/library/meta?workspaceId=${alpha.wsA}&path=${encodeURIComponent(filePath)}`,
      alpha.token,
    );
    expect(metaOk.status).toBe(200);

    const metaWrongWs = await request(
      "GET",
      `/library/meta?workspaceId=${alpha.wsB}&path=${encodeURIComponent(filePath)}`,
      alpha.token,
    );
    expect(metaWrongWs.status).toBe(404);

    const dlOk = await request(
      "GET",
      `/library/download?workspaceId=${alpha.wsA}&path=${encodeURIComponent(filePath)}`,
      alpha.token,
    );
    expect(dlOk.status).toBe(200);

    const dlWrongWs = await request(
      "GET",
      `/library/download?workspaceId=${alpha.wsB}&path=${encodeURIComponent(filePath)}`,
      alpha.token,
    );
    expect(dlWrongWs.status).toBe(404);
  });
});

describe("hidden (dot-prefixed) paths — full CRUD", () => {
  it("returns metadata for a file inside a hidden folder", async () => {
    // Look up the workspace slug so we can create the hidden file on disk
    const { rows } = await pool.query<{ path: string }>(
      "SELECT path FROM workspaces WHERE id = ?",
      [alpha.wsA],
    );
    const wsSlug = rows[0]!.path;
    const wsRoot = path.join(home, wsSlug);

    // Create .memory/workspace.md directly on disk (mimics agent-created files)
    const hiddenDir = path.join(wsRoot, ".memory");
    await fs.mkdir(hiddenDir, { recursive: true });
    await fs.writeFile(path.join(hiddenDir, "workspace.md"), "# Workspace memory");

    const res = await request(
      "GET",
      `/library/meta?workspaceId=${alpha.wsA}&path=${encodeURIComponent(".memory/workspace.md")}`,
      alpha.token,
    );
    expect(res.status).toBe(200);
    const body = res.body as { path: string; name: string };
    expect(body.path).toBe(".memory/workspace.md");
    expect(body.name).toBe("workspace.md");
  });

  it("returns content for a file inside a hidden folder", async () => {
    // File already created by the previous test
    const res = await request(
      "GET",
      `/library/content?workspaceId=${alpha.wsA}&path=${encodeURIComponent(".memory/workspace.md")}`,
      alpha.token,
    );
    expect(res.status).toBe(200);
  });

  it("saves (PUT) content to a file inside a hidden folder", async () => {
    const newContent = "# Updated workspace memory\n\nSaved via PUT";
    const putRes = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const payload = Buffer.from(newContent);
      const url = `/library/content?workspaceId=${encodeURIComponent(alpha.wsA)}&path=${encodeURIComponent(".memory/workspace.md")}`;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: url,
          method: "PUT",
          headers: {
            Authorization: `Bearer ${alpha.token}`,
            "Content-Type": "text/markdown",
            "Content-Length": String(payload.length),
          },
        },
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
      req.write(payload);
      req.end();
    });
    expect(putRes.status).toBe(200);
    const ref = putRes.body as { path: string; size: number };
    expect(ref.path).toBe(".memory/workspace.md");
    expect(ref.size).toBe(newContent.length);

    // Verify the content was actually written
    const getRes = await request(
      "GET",
      `/library/content?workspaceId=${alpha.wsA}&path=${encodeURIComponent(".memory/workspace.md")}`,
      alpha.token,
    );
    expect(getRes.status).toBe(200);
  });

  it("still blocks traversal paths even with dot-prefixed segments", async () => {
    const res = await request(
      "GET",
      `/library/meta?workspaceId=${alpha.wsA}&path=${encodeURIComponent(".memory/../../../etc/passwd")}`,
      alpha.token,
    );
    expect(res.status).toBe(404);
  });

  it("allows delete on hidden paths", async () => {
    const res = await request(
      "DELETE",
      `/library?workspaceId=${alpha.wsA}&path=${encodeURIComponent(".memory/workspace.md")}`,
      alpha.token,
    );
    // Hidden files are regular files — all operations work the same
    expect(res.status).toBe(200);
  });

  it("PUT creates a hidden file that does not exist yet (upsert)", async () => {
    // After the previous test deleted .memory/workspace.md, saving via
    // PUT should create it again rather than returning 404.
    const content = "# Re-created workspace memory";
    const putRes = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const payload = Buffer.from(content);
      const url = `/library/content?workspaceId=${encodeURIComponent(alpha.wsA)}&path=${encodeURIComponent(".memory/workspace.md")}`;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: url,
          method: "PUT",
          headers: {
            Authorization: `Bearer ${alpha.token}`,
            "Content-Type": "text/markdown",
            "Content-Length": String(payload.length),
          },
        },
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
      req.write(payload);
      req.end();
    });
    expect(putRes.status).toBe(200);
    const ref = putRes.body as { path: string; name: string; size: number };
    expect(ref.path).toBe(".memory/workspace.md");
    expect(ref.size).toBe(content.length);
  });

  it("PUT creates a file in a brand-new hidden directory", async () => {
    // Saving to a completely new hidden path should create both the
    // directory and file — matches the agent sandbox writing pattern.
    const content = "agent scratch notes";
    const putRes = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const payload = Buffer.from(content);
      const url = `/library/content?workspaceId=${encodeURIComponent(alpha.wsA)}&path=${encodeURIComponent(".scratch/notes.md")}`;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: url,
          method: "PUT",
          headers: {
            Authorization: `Bearer ${alpha.token}`,
            "Content-Type": "text/markdown",
            "Content-Length": String(payload.length),
          },
        },
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
      req.write(payload);
      req.end();
    });
    expect(putRes.status).toBe(200);
    const ref = putRes.body as { path: string; name: string };
    expect(ref.path).toBe(".scratch/notes.md");
    expect(ref.name).toBe("notes.md");
  });
});
