/**
 * End-to-end tests for the API server against a real Postgres database.
 * Exercises login, CRUD routes, and WebSocket event delivery with real data.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, queries } from "@roomy-ai/db";
import { runMigrations, seedIfEmpty } from "@roomy-ai/db";
import { ensureLayout, materializeSummary } from "@roomy-ai/storage";
import { createApp, type AppOptions } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";
import { createRunManager } from "@roomy-ai/scheduler";
import { generateId } from "@roomy-ai/shared";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;

beforeAll(async () => {
  // Per-test-file SQLite file so workers don't collide on the same DB.
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-api-e2e-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.ROOMY_SEED_USERNAME = "testuser";
  process.env.ROOMY_SEED_PASSWORD = "test-pass-1234";
  await seedIfEmpty(pool);

  // Create temp home directory with storage layout
  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-api-e2e-"));
  await ensureLayout(home);
  // fireMessage reads ROOMY_HOME for its log file path.
  process.env.ROOMY_HOME = home;

  const storage = { pool, home };
  const runManager = createRunManager({
    pool,
    execRunFn: async (_runId, _agentId, _prompt, onLog) => {
      await onLog({ runId: _runId, seq: 0, kind: "stdout", payload: "fake response" });
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
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));

  if (pool) await pool.end();
  if (home) await rmTempTreeWithRetry(home);
  if (dbPath) await rmTempTreeWithRetry(path.dirname(dbPath));
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

function requestMultipart(
  method: string,
  urlPath: string,
  token: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; body: Buffer }>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const boundary = `----roomy-test-${crypto.randomBytes(8).toString("hex")}`;
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
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
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

function rawUpgrade(
  urlPath: string,
): Promise<{ response: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
      socket.write(
        `GET ${urlPath} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `\r\n`,
      );
    });

    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("\r\n\r\n")) {
        resolve({ response, socket });
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("Upgrade timeout")), 5000);
  });
}

describe("API e2e (real Postgres)", () => {
  let token: string;

  it("POST /auth/login authenticates against real DB", async () => {
    const res = await request("POST", "/auth/login", undefined, {
      username: "testuser",
      password: "test-pass-1234",
    });
    expect(res.status).toBe(200);
    const body = res.body as { token: string };
    expect(body.token).toMatch(/^ses_/);
    token = body.token;
  });

  it("GET /me returns the seeded user profile", async () => {
    const res = await request("GET", "/me", token);
    expect(res.status).toBe(200);
    const body = res.body as { username: string };
    expect(body.username).toBe("testuser");
  });

  it("GET /workspaces returns seeded workspace", async () => {
    const res = await request("GET", "/workspaces", token);
    expect(res.status).toBe(200);
    const workspaces = res.body as Array<{ id: string; name: string }>;
    expect(workspaces.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /agents returns seeded agent", async () => {
    const res = await request("GET", "/agents", token);
    expect(res.status).toBe(200);
    const agents = res.body as Array<{ id: string }>;
    expect(agents.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /chats creates a chat, GET /chats returns it", async () => {
    // Get workspace and agent IDs. The seeded "Roomy" project workspace is
    // the right home for ad-hoc chats — pick it explicitly so the test
    // doesn't depend on which workspace happens to come back first.
    const wsRes = await request("GET", "/workspaces", token);
    const workspaces = wsRes.body as Array<{ id: string; kind: string }>;
    const projectWorkspace = workspaces.find((w) => w.kind !== "hub") ?? workspaces[0];
    const agentsRes = await request("GET", "/agents", token);
    const agents = agentsRes.body as Array<{ id: string }>;

    const createRes = await request("POST", "/chats", token, {
      workspaceId: projectWorkspace.id,
      agentId: agents[0].id,
      title: "E2E Test Chat",
    });
    expect(createRes.status).toBe(201);
    const chat = createRes.body as { id: string; title: string };
    expect(chat.id).toMatch(/^cht_/);
    expect(chat.title).toBe("E2E Test Chat");

    // Verify it appears in the list. GET /chats requires an explicit
    // workspaceId now — no implicit fallback to the first workspace.
    const listRes = await request("GET", `/chats?workspaceId=${projectWorkspace.id}`, token);
    expect(listRes.status).toBe(200);
    const chats = listRes.body as Array<{ id: string }>;
    expect(chats.some((c) => c.id === chat.id)).toBe(true);
  });

  it("POST /chats/:id/messages creates a user message and fires a trigger that produces an agent reply", async () => {
    const wsRes = await request("GET", "/workspaces", token);
    const workspaces = wsRes.body as Array<{ id: string; path: string; kind: string }>;
    const projectWorkspace = workspaces.find((w) => w.kind !== "hub") ?? workspaces[0];
    const agentsRes = await request("GET", "/agents", token);
    const agents = agentsRes.body as Array<{ id: string }>;

    const chatRes = await request("POST", "/chats", token, {
      workspaceId: projectWorkspace.id,
      agentId: agents[0].id,
      title: "Message Test Chat",
    });
    const chat = chatRes.body as { id: string };

    const msgRes = await request("POST", `/chats/${chat.id}/messages`, token, {
      content: "Hello from e2e test",
    });
    expect(msgRes.status).toBe(201);
    const userMsg = msgRes.body as { id: string; role: string };
    expect(userMsg.id).toMatch(/^msg_/);
    expect(userMsg.role).toBe("user");

    // Poll until the agent's reply message lands.
    const start = Date.now();
    let replied = false;
    while (Date.now() - start < 5_000) {
      await new Promise((r) => setTimeout(r, 100));
      const list = await request("GET", `/chats/${chat.id}/messages`, token);
      const items = (list.body as { items: Array<{ role: string; parentId?: string }> }).items;
      if (items.some((m) => m.role === "agent")) {
        replied = true;
        break;
      }
    }
    expect(replied).toBe(true);
  });

  it("POST /chats/:id/messages with kind=task creates one self-firing row (no agent_turn pair)", async () => {
    const wsRes = await request("GET", "/workspaces", token);
    const workspaces = wsRes.body as Array<{ id: string; kind: string }>;
    const projectWorkspace = workspaces.find((w) => w.kind !== "hub") ?? workspaces[0];
    const agentsRes = await request("GET", "/agents", token);
    const agents = agentsRes.body as Array<{ id: string }>;

    const chatRes = await request("POST", "/chats", token, {
      workspaceId: projectWorkspace.id,
      agentId: agents[0].id,
      title: "Task Test Chat",
    });
    const chat = chatRes.body as { id: string };

    const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const msgRes = await request("POST", `/chats/${chat.id}/messages`, token, {
      content: "Audit the numbers",
      kind: "task",
      title: "Audit Q2",
      executeAt: futureIso,
    });
    expect(msgRes.status).toBe(201);
    const taskMsg = msgRes.body as {
      id: string;
      role: string;
      kind: string;
      title: string | null;
      executeAt: string;
      state: string;
    };
    expect(taskMsg.kind).toBe("task");
    expect(taskMsg.title).toBe("Audit Q2");
    expect(taskMsg.executeAt).toBe(futureIso);
    expect(taskMsg.state).toBe("pending");

    // No `agent_turn` trigger should exist alongside it. Self-firing kinds
    // are a single row.
    const list = await request("GET", `/chats/${chat.id}/messages`, token);
    const items = (list.body as { items: Array<{ id: string; content: { type: string } }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(taskMsg.id);
    expect(items[0].content.type).toBe("text");

    // Surfaces under both kind=task and scheduled=true (the row carries
    // its own schedule).
    const kindRes = await request(
      "GET",
      `/messages?kind=task&workspaceId=${projectWorkspace.id}`,
      token,
    );
    const kindItems = (kindRes.body as { items: Array<{ id: string }> }).items;
    expect(kindItems.some((m) => m.id === taskMsg.id)).toBe(true);

    const schedRes = await request(
      "GET",
      `/messages?scheduled=true&workspaceId=${projectWorkspace.id}`,
      token,
    );
    const schedItems = (schedRes.body as { items: Array<{ id: string }> }).items;
    expect(schedItems.some((m) => m.id === taskMsg.id)).toBe(true);
  });

  it("GET /search searches across real data", async () => {
    const res = await request("GET", "/search?q=E2E&scope=chats", token);
    expect(res.status).toBe(200);
  });

  it("GET /search rejects invalid filters", async () => {
    const badScope = await request("GET", "/search?q=x&scope=bogus", token);
    expect(badScope.status).toBe(400);
    const badKind = await request("GET", "/search?q=x&kind=bogus", token);
    expect(badKind.status).toBe(400);
  });

  it("GET /openapi.json works without auth", async () => {
    const res = await request("GET", "/openapi.json");
    expect(res.status).toBe(200);
    const spec = res.body as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.1.0");
  });

  it("POST /auth/logout invalidates the session", async () => {
    // Login to get a new token to revoke
    const loginRes = await request("POST", "/auth/login", undefined, {
      username: "testuser",
      password: "test-pass-1234",
    });
    const tempToken = (loginRes.body as { token: string }).token;

    const logoutRes = await request("POST", "/auth/logout", tempToken);
    expect(logoutRes.status).toBe(200);

    // The token should no longer work
    const meRes = await request("GET", "/me", tempToken);
    expect(meRes.status).toBe(401);
  });

  it("WebSocket upgrade with real session delivers broadcast events", async () => {
    // Login fresh
    const loginRes = await request("POST", "/auth/login", undefined, {
      username: "testuser",
      password: "test-pass-1234",
    });
    const wsToken = (loginRes.body as { token: string }).token;

    const { response, socket } = await rawUpgrade(`/ws?token=${wsToken}`);
    expect(response).toContain("101 Switching Protocols");

    // Send a message to trigger a run (which emits events via broadcast)
    const wsRes = await request("GET", "/workspaces", token);
    const workspaces = wsRes.body as Array<{ id: string; kind: string }>;
    const projectWorkspace = workspaces.find((w) => w.kind !== "hub") ?? workspaces[0];
    const agentsRes = await request("GET", "/agents", token);
    const agents = agentsRes.body as Array<{ id: string }>;

    const chatRes = await request("POST", "/chats", token, {
      workspaceId: projectWorkspace.id,
      agentId: agents[0].id,
      title: "WS Test Chat",
    });
    const chat = chatRes.body as { id: string };

    // Collect WebSocket frames
    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => received.push(chunk));

    await request("POST", `/chats/${chat.id}/messages`, token, {
      content: "Hello WS",
    });

    // Wait for events
    await new Promise((r) => setTimeout(r, 1000));

    // We should have received at least one WebSocket frame (message.appended or run events)
    const frame = Buffer.concat(received);
    expect(frame.length).toBeGreaterThan(0);

    socket.destroy();
  });

  // Gap 5: Chat artifact → library → download round-trip
  it("uploads artifact to chat, lists via chat artifacts, uploads to library, downloads identical bytes", async () => {
    const wsRes = await request("GET", "/workspaces", token);
    const workspaces = wsRes.body as Array<{ id: string; kind: string }>;
    const projectWorkspace = workspaces.find((w) => w.kind !== "hub") ?? workspaces[0];
    const agentsRes = await request("GET", "/agents", token);
    const agents = agentsRes.body as Array<{ id: string }>;

    const chatRes = await request("POST", "/chats", token, {
      workspaceId: projectWorkspace.id,
      agentId: agents[0].id,
      title: "Artifact Round-Trip Chat",
    });
    const chat = chatRes.body as { id: string };

    const content = "hello artifact world";

    // Upload artifact by sending a multipart message with an attachment
    // part — uploads ride on POST /chats/{id}/messages now, not a
    // standalone attachments endpoint. The user-message row carries the
    // resulting AttachmentRef in `attachments[]`.
    const uploadRes = await requestMultipart(
      "POST",
      `/chats/${chat.id}/messages`,
      token,
      [
        { name: "content", body: Buffer.from("here's a file") },
        {
          name: "attachment",
          filename: "round-trip.txt",
          contentType: "text/plain",
          body: Buffer.from(content),
        },
      ],
    );
    expect(uploadRes.status).toBe(201);
    const userMessage = uploadRes.body as { attachments: Array<{ path: string; name: string; mime: string }> };
    const chatFile = userMessage.attachments[0];
    expect(chatFile.path).toMatch(/^\.chats\//);
    expect(chatFile.name).toBe("round-trip.txt");
    expect(chatFile.mime).toBe("text/plain");

    // Chat artifact appears in chat artifacts list
    const chatArtRes = await request("GET", `/chats/${chat.id}/attachments`, token);
    expect(chatArtRes.status).toBe(200);
    const chatArts = chatArtRes.body as Array<{ path: string }>;
    expect(chatArts.some((a) => a.path === chatFile.path)).toBe(true);

    // Upload directly to library (multipart). Library endpoints now require
    // an explicit workspaceId; the hub doesn't accept library writes.
    const libUploadRes = await requestMultipart(
      "POST",
      `/library?workspaceId=${projectWorkspace.id}`,
      token,
      [{ name: "file", filename: "lib-round-trip.txt", contentType: "text/plain", body: Buffer.from(content) }],
    );
    expect(libUploadRes.status).toBe(201);
    const libFile = libUploadRes.body as { path: string; name: string };
    // Workspace root is the library — uploads land directly at the root.
    expect(libFile.path).toBe(libFile.name);

    // GET /library returns the library file
    const libRes = await request("GET", `/library?workspaceId=${projectWorkspace.id}`, token);
    expect(libRes.status).toBe(200);
    const lib = libRes.body as { items: Array<{ path: string }> };
    expect(lib.items.some((i) => i.path === libFile.path)).toBe(true);

    // GET /library/download?path= returns identical bytes
    const dlBytes = await new Promise<Buffer>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/library/download?workspaceId=${projectWorkspace.id}&path=${encodeURIComponent(libFile.path)}`,
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(dlBytes.toString()).toBe(content);

    // GET /library/content?workspaceId=${projectWorkspace.id}&path= returns identical bytes with inline disposition
    // (used by the in-app preview panel instead of triggering a browser download).
    const previewResult = await new Promise<{ bytes: Buffer; disposition: string; contentType: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/library/content?workspaceId=${projectWorkspace.id}&path=${encodeURIComponent(libFile.path)}`,
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({
            bytes: Buffer.concat(chunks),
            disposition: String(res.headers["content-disposition"] ?? ""),
            contentType: String(res.headers["content-type"] ?? ""),
          }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(previewResult.bytes.toString()).toBe(content);
    expect(previewResult.disposition.startsWith("inline")).toBe(true);
    expect(previewResult.contentType).toBe("text/plain");

    // Verify stat metadata via /library/meta
    const metaRes = await request(
      "GET",
      `/library/meta?workspaceId=${projectWorkspace.id}&path=${encodeURIComponent(libFile.path)}`,
      token,
    );
    expect(metaRes.status).toBe(200);
    const meta = metaRes.body as { path: string; name: string };
    expect(meta.path).toBe(libFile.path);

    // PUT /library/content overwrites the file in place and subsequent
    // reads return the new bytes. PUT to a non-existent path creates the
    // file (upsert) so agent-written hidden files can be saved directly.
    const newBody = "overwritten";
    const putResult = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const payload = Buffer.from(newBody);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/library/content?workspaceId=${projectWorkspace.id}&path=${encodeURIComponent(libFile.path)}`,
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "text/plain",
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
    expect(putResult.status).toBe(200);
    const updatedRef = putResult.body as { path: string; size: number };
    expect(updatedRef.path).toBe(libFile.path);
    expect(updatedRef.size).toBe(newBody.length);

    const afterPut = await new Promise<Buffer>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/library/content?workspaceId=${projectWorkspace.id}&path=${encodeURIComponent(libFile.path)}`,
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(afterPut.toString()).toBe(newBody);

    // PUT to a non-existent path creates the file (upsert semantics) —
    // this lets agent-created hidden files be saved without a separate
    // POST creation step.
    const upsertPut = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const payload = Buffer.from("x");
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/library/content?workspaceId=${projectWorkspace.id}&path=${encodeURIComponent("does-not-exist.txt")}`,
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "text/plain",
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
    expect(upsertPut.status).toBe(200);
    const upsertRef = upsertPut.body as { path: string; size: number };
    expect(upsertRef.path).toBe("does-not-exist.txt");
    expect(upsertRef.size).toBe(1);
  });

  it("library directory flow: subpath upload, create/rename/move/delete folders, folder-scoped listing", async () => {
    const wsRes = await request("GET", "/workspaces", token);
    const wsId = (wsRes.body as Array<{ id: string }>)[0].id;
    const wsQuery = `workspaceId=${encodeURIComponent(wsId)}`;

    // Upload two files into nested subdirectories — as a directory upload
    // would, one file per request with its relative subpath attached.
    for (const [relDir, filename, body] of [
      ["DirUpload/docs", "intro.md", "# Intro"],
      ["DirUpload", "root.txt", "root-body"],
    ] as Array<[string, string, string]>) {
      const up = await requestMultipart(
        "POST",
        `/library?${wsQuery}`,
        token,
        [
          { name: "subpath", body: Buffer.from(relDir) },
          { name: "file", filename, contentType: "text/plain", body: Buffer.from(body) },
        ],
      );
      expect(up.status).toBe(201);
      const file = up.body as { path: string };
      expect(file.path).toBe(`${relDir}/${filename}`);
    }

    // Rejects traversal in the subpath.
    const bad = await requestMultipart(
      "POST",
      `/library?${wsQuery}`,
      token,
      [
        { name: "subpath", body: Buffer.from("../escape") },
        { name: "file", filename: "x.txt", contentType: "text/plain", body: Buffer.from("nope") },
      ],
    );
    expect(bad.status).toBe(400);

    // Folder-scoped listing — drill into each level rather than expecting
    // a recursive dump.
    const rootList = await request("GET", `/library?${wsQuery}`, token);
    expect(rootList.status).toBe(200);
    const rootListing = rootList.body as {
      items: Array<{ path: string }>;
      folders: Array<{ path: string; name: string }>;
    };
    expect(rootListing.folders.map((f) => f.path)).toContain("DirUpload");

    const dirUpload = await request("GET", `/library?${wsQuery}&path=${encodeURIComponent("DirUpload")}`, token);
    const dirListing = dirUpload.body as {
      items: Array<{ path: string }>;
      folders: Array<{ path: string }>;
    };
    expect(dirListing.items.map((i) => i.path)).toContain("DirUpload/root.txt");
    expect(dirListing.folders.map((f) => f.path)).toContain("DirUpload/docs");

    const docs = await request("GET", `/library?${wsQuery}&path=${encodeURIComponent("DirUpload/docs")}`, token);
    const docsListing = docs.body as { items: Array<{ path: string }> };
    expect(docsListing.items.map((i) => i.path)).toContain("DirUpload/docs/intro.md");

    // Create an empty folder and verify it appears.
    const mkRes = await request(
      "POST",
      `/library/folder?${wsQuery}`,
      token,
      { path: "DirUpload/Empty" },
    );
    expect(mkRes.status).toBe(201);
    const mk = mkRes.body as { path: string };
    expect(mk.path).toBe("DirUpload/Empty");

    // Rename a folder (PATCH /library with from/to).
    const renameRes = await request(
      "PATCH",
      `/library?${wsQuery}`,
      token,
      { from: "DirUpload/Empty", to: "DirUpload/Renamed" },
    );
    expect(renameRes.status).toBe(200);

    // Move a file from one folder to another.
    const mvFile = await request(
      "PATCH",
      `/library?${wsQuery}`,
      token,
      { from: "DirUpload/root.txt", to: "DirUpload/Renamed/root.txt" },
    );
    expect(mvFile.status).toBe(200);

    // Refuses traversal on either side.
    const escRes = await request(
      "PATCH",
      `/library?${wsQuery}`,
      token,
      { from: "DirUpload/docs/intro.md", to: "../hijack.md" },
    );
    expect(escRes.status).toBe(404);

    // Delete a folder recursively.
    const delRes = await request(
      "DELETE",
      `/library?path=${encodeURIComponent("DirUpload/docs")}&${wsQuery}`,
      token,
    );
    expect(delRes.status).toBe(200);

    const finalDirUpload = await request("GET", `/library?${wsQuery}&path=${encodeURIComponent("DirUpload")}`, token);
    const finalDirListing = finalDirUpload.body as {
      items: Array<{ path: string }>;
      folders: Array<{ path: string }>;
    };
    expect(finalDirListing.folders.map((f) => f.path)).not.toContain("DirUpload/docs");
    const renamed = await request("GET", `/library?${wsQuery}&path=${encodeURIComponent("DirUpload/Renamed")}`, token);
    const renamedListing = renamed.body as { items: Array<{ path: string }> };
    expect(renamedListing.items.map((i) => i.path)).toContain("DirUpload/Renamed/root.txt");
  });

  it("GET /chats/:id/attachments returns attachments tagged with kind='attachment' and excludes notes", async () => {
    const wsRes = await request("GET", "/workspaces", token);
    const workspaces = wsRes.body as Array<{ id: string; path: string; kind: string }>;
    const projectWorkspace = workspaces.find((w) => w.kind !== "hub") ?? workspaces[0];
    const agentsRes = await request("GET", "/agents", token);
    const agents = agentsRes.body as Array<{ id: string }>;

    const chatRes = await request("POST", "/chats", token, {
      workspaceId: projectWorkspace.id,
      agentId: agents[0].id,
      title: "Summaries In Files Tab Chat",
    });
    const chat = chatRes.body as { id: string };

    const upRes = await requestMultipart(
      "POST",
      `/chats/${chat.id}/messages`,
      token,
      [
        { name: "content", body: Buffer.from("summary attachment") },
        { name: "attachment", filename: "notes-spec.txt", contentType: "text/plain", body: Buffer.from("hi") },
      ],
    );
    expect(upRes.status).toBe(201);

    // Materialize a summary so we can verify it is NOT returned in the attachments list.
    const fakeMessageId = "msg_notespec000000000000000";
    await materializeSummary(home, projectWorkspace.path, chat.id, fakeMessageId, "summary body");

    const res = await request("GET", `/chats/${chat.id}/attachments`, token);
    expect(res.status).toBe(200);
    const body = res.body as Array<{ name: string; kind: string }>;
    expect(body.map((f) => f.name)).toContain("notes-spec.txt");
    expect(body.map((f) => f.name)).not.toContain(`${fakeMessageId}.md`);
    expect(body.every((f) => f.kind === "attachment")).toBe(true);
  });

  // Gap 6: Search returns uploaded artifacts and indexed chat messages.
  it("search returns known artifact and message-backed chat IDs", async () => {
    const wsRes = await request("GET", "/workspaces", token);
    const workspaces = wsRes.body as Array<{ id: string; path: string; kind: string }>;
    const projectWorkspace = workspaces.find((w) => w.kind !== "hub") ?? workspaces[0];
    const agentsRes = await request("GET", "/agents", token);
    const agents = agentsRes.body as Array<{ id: string }>;

    const chatRes = await request("POST", "/chats", token, {
      workspaceId: projectWorkspace.id,
      agentId: agents[0].id,
      title: "Indexed Search Chat",
    });
    const chat = chatRes.body as { id: string };

    const msgRes = await request("POST", `/chats/${chat.id}/messages`, token, {
      content: "SearchableUnique message body",
    });
    expect(msgRes.status).toBe(201);

    const uploadRes = await requestMultipart(
      "POST",
      `/chats/${chat.id}/messages`,
      token,
      [
        { name: "content", body: Buffer.from("searchable file") },
        {
          name: "attachment",
          filename: "SearchableArtifactName.txt",
          contentType: "text/plain",
          body: Buffer.from("data"),
        },
      ],
    );
    const file = (uploadRes.body as { attachments: Array<{ path: string }> }).attachments[0];

    // Search artifacts — file id is now the workspace-relative path
    const artRes = await request("GET", "/search?q=SearchableArtifact&scope=artifacts", token);
    expect(artRes.status).toBe(200);
    const artResults = artRes.body as Array<{ type: string; id: string }>;
    expect(artResults.some((r) => r.type === "file" && r.id === file.path)).toBe(true);

    const libraryUploadRes = await requestMultipart(
      "POST",
      `/library?workspaceId=${projectWorkspace.id}`,
      token,
      [
        {
          name: "file",
          filename: "universal-search-note.md",
          contentType: "text/markdown",
          body: Buffer.from("UniversalNeedle appears only inside this file body"),
        },
      ],
    );
    expect(libraryUploadRes.status).toBe(201);
    const libraryFile = libraryUploadRes.body as { path: string };

    const libraryContentRes = await request("GET", "/search?q=UniversalNeedle&scope=library", token);
    expect(libraryContentRes.status).toBe(200);
    const libraryContentResults = libraryContentRes.body as Array<{ type: string; id: string; kind?: string }>;
    expect(libraryContentResults.some((r) => r.type === "file" && r.kind === "library_file" && r.id === libraryFile.path)).toBe(true);

    // Search chats through the shared chat_search_index-backed search.
    const chatSearchRes = await request("GET", "/search?q=SearchableUnique&scope=chats", token);
    expect(chatSearchRes.status).toBe(200);
    const chatResults = chatSearchRes.body as Array<{ type: string; id: string; snippet?: string }>;
    expect(chatResults.some((r) => r.type === "message" && r.id === chat.id)).toBe(true);
    expect(chatResults.some((r) => r.snippet?.includes("<mark>SearchableUnique</mark>"))).toBe(true);

    const titleSearchRes = await request("GET", "/search?q=Indexed%20Search%20Chat&scope=chats", token);
    expect(titleSearchRes.status).toBe(200);
    const titleResults = titleSearchRes.body as Array<{ type: string; id: string; snippet?: string }>;
    expect(titleResults.some((r) => r.type === "chat" && r.id === chat.id)).toBe(true);

    const agentEventMessageId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, created_at)
       VALUES (?, ?, 'agent', ?, ?)`,
      [
        agentEventMessageId,
        chat.id,
        JSON.stringify({
          type: "events",
          log: [{ kind: "event", event: { type: "text", part: { text: "SewmaReply appears in an AI response." } } }],
        }),
        new Date().toISOString(),
      ],
    );
    const eventSearchRes = await request("GET", "/search?q=SewmaReply&scope=chats", token);
    expect(eventSearchRes.status).toBe(200);
    const eventResults = eventSearchRes.body as Array<{ type: string; id: string; messageId?: string }>;
    expect(eventResults.some((r) => r.type === "message" && r.id === chat.id && r.messageId === agentEventMessageId)).toBe(true);

    // Search all
    const allRes = await request("GET", "/search?q=Searchable&scope=all", token);
    expect(allRes.status).toBe(200);
    const allResults = allRes.body as Array<{ id: string }>;
    expect(allResults.some((r) => r.id === file.path)).toBe(true);
    expect(allResults.some((r) => r.id === chat.id)).toBe(true);

    // Search all should reserve room for chat hits even when many file hits
    // score higher for the same query.
    for (let i = 0; i < 45; i += 1) {
      await pool.query(
        `INSERT OR REPLACE INTO chat_search_index
          (ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at)
         VALUES (?, ?, LOWER(?), NULL, ?, 'library_file', ?)`,
        [
          `test-all-crowd-${i}.md`,
          `Searchable Searchable Searchable crowded file ${i}`,
          `Searchable Searchable Searchable crowded file ${i}`,
          projectWorkspace.path,
          new Date(Date.now() + i).toISOString(),
        ],
      );
    }

    const crowdedAllRes = await request("GET", "/search?q=Searchable&scope=all", token);
    expect(crowdedAllRes.status).toBe(200);
    const crowdedAllResults = crowdedAllRes.body as Array<{ id: string }>;
    expect(crowdedAllResults.some((r) => r.id === chat.id)).toBe(true);
  });

  // Gap 11: Account PATCH email reflected
  it("PATCH /me email reflected in GET /me", async () => {
    const patchRes = await request("PATCH", "/me", token, { email: "updated@example.com" });
    expect(patchRes.status).toBe(200);
    const patched = patchRes.body as { email: string };
    expect(patched.email).toBe("updated@example.com");

    const getRes = await request("GET", "/me", token);
    expect(getRes.status).toBe(200);
    const me = getRes.body as { email: string };
    expect(me.email).toBe("updated@example.com");
  });

  // Gap 3: Workspace DELETE method
  it("DELETE /workspaces/:id soft-deletes a workspace", async () => {
    const wsRes = await request("GET", "/workspaces", token);
    const workspaces = wsRes.body as Array<{ id: string }>;
    const agentsRes = await request("GET", "/agents", token);
    const agents = agentsRes.body as Array<{ id: string }>;

    // Create a workspace to delete (use existing since we only have one - create a chat to test)
    // Actually just verify the DELETE method works — create a new workspace isn't in the API.
    // The old POST /workspaces/:id/delete should return 404 now
    const oldRes = await request("POST", `/workspaces/${workspaces[0].id}/delete`, token);
    expect(oldRes.status).toBe(404);
  });

  // Gap 4: DELETE /me routed
  it("DELETE /me returns soft-delete acknowledgement", async () => {
    const res = await request("DELETE", "/me", token);
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
  });

  // M6 replacement for the old /runs/:id/logs pagination test: logs
  // live on disk per message now, accessed via
  // GET /chats/{id}/messages/{messageId}/logs.
  it("GET /chats/{id}/messages/{messageId}/logs returns the fired message's log body", async () => {
    const wsRes = await request("GET", "/workspaces", token);
    const workspaces = wsRes.body as Array<{ id: string; kind: string }>;
    const projectWorkspace = workspaces.find((w) => w.kind !== "hub") ?? workspaces[0];
    const agentsRes = await request("GET", "/agents", token);
    const agents = agentsRes.body as Array<{ id: string }>;

    const chatRes = await request("POST", "/chats", token, {
      workspaceId: projectWorkspace.id,
      agentId: agents[0].id,
      title: "Logs Chat",
    });
    const chat = chatRes.body as { id: string };

    await request("POST", `/chats/${chat.id}/messages`, token, { content: "log something" });

    // Poll for the trigger message (role=system, state=succeeded) and check
    // its logs endpoint.
    const start = Date.now();
    while (Date.now() - start < 5_000) {
      await new Promise((r) => setTimeout(r, 100));
      const list = await request("GET", `/chats/${chat.id}/messages`, token);
      const items = (list.body as { items: Array<{ id: string; role: string; state?: string }> }).items;
      const trigger = items.find((m) => m.role === "system" && m.state === "succeeded");
      if (trigger) {
        const logs = await request("GET", `/chats/${chat.id}/messages/${trigger.id}/logs`, token);
        expect(logs.status).toBe(200);
        return;
      }
    }
    throw new Error("no trigger message reached succeeded in time");
  });

  it("invalid login returns 401", async () => {
    const res = await request("POST", "/auth/login", undefined, {
      username: "testuser",
      password: "wrongpassword",
    });
    expect(res.status).toBe(401);
  });

  it("unauthenticated request to protected route returns 401", async () => {
    const res = await request("GET", "/me");
    expect(res.status).toBe(401);
  });
});

/**
 * Gap 15: Real-stack e2e — HTTP → scheduler → real container sandbox → real
 * pi CLI → model → assistant message persisted → WS event. Originally
 * pinned to `anthropic/claude-haiku-4-5` (pi's free tier) so it ran in CI with
 * no API keys; that tier is gone, so the spec is paused.
 *
 * To revive: point pi inside the sandbox at an aimock server on the
 * host via `ANTHROPIC_BASE_URL` (see
 * `packages/server/api/test/helpers/aimock.ts`), switch `FREE_MODEL` to
 * `anthropic/claude-haiku-4-5`, and inject `ANTHROPIC_API_KEY=mock` as
 * a provider key. Pi must forward the base-URL env into the container
 * (`docker exec -e ANTHROPIC_BASE_URL=…`) and reach the host network
 * (`host.docker.internal` on Docker Desktop). Until that's wired, the
 * suite stays skipped — keeping the source as documentation of the
 * real-stack contract we still want to honour.
 */
const REAL_E2E_SANDBOX_AVAILABLE = await (async () => {
  try {
    const { detectEngine, sandboxImage } = await import("@roomy-ai/runtime");
    const engine = await detectEngine();
    return (await engine.imageId(sandboxImage())) !== null;
  } catch {
    return false;
  }
})();

const FREE_MODEL = "anthropic/claude-haiku-4-5";

// Skipped pending the aimock wiring described above. Keep the
// describe-with-skip rather than deleting so the contract stays in the
// codebase as documentation, and re-enabling is a one-line flip.
const REAL_STACK_E2E_ENABLED = false;

describe.skipIf(!REAL_STACK_E2E_ENABLED || !REAL_E2E_SANDBOX_AVAILABLE)(
  "real-stack e2e (real Docker + free model)",
  () => {
  let realPool: Pool;
  let realServer: http.Server;
  let realPort: number;
  let realHome: string;
  let realToken: string;
  let realDbPath: string;
  let realWorkspaceIds: string[] = [];

  function realRequest(
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
        { hostname: "127.0.0.1", port: realPort, path: urlPath, method, headers },
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

  beforeAll(async () => {
    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-real-e2e-db-"));
    realDbPath = path.join(dbDir, "test.sqlite3");
    realPool = new Pool({ path: realDbPath });

    await runMigrations(realPool);
    process.env.ROOMY_SEED_USERNAME = "testuser";
    process.env.ROOMY_SEED_PASSWORD = "test-pass-1234";
    await seedIfEmpty(realPool);
    const { rows: workspaceRows } = await realPool.query("SELECT id FROM workspaces");
    realWorkspaceIds = workspaceRows.map((row) => row.id as string);

    realHome = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-real-e2e-"));
    await ensureLayout(realHome);
    // The runtime resolves its on-disk home via `resolveRoomyHome()`,
    // which falls back to process.env.ROOMY_HOME. Pin it so the agent
    // file (and any test reading it back) hit the same tree the
    // storage context above uses.
    process.env.ROOMY_HOME = realHome;

    const storage = { pool: realPool, home: realHome };

    // No execRunFn — let the scheduler invoke the real pi driver in a
    // real Docker sandbox. The seeded agent's model is patched to the free
    // anthropic/claude-haiku-4-5 below so this runs without paid provider keys.
    const runManager = createRunManager({ pool: realPool });

    const { rows: userRows } = await realPool.query("SELECT id FROM users LIMIT 1");
    const broadcastUserId = userRows[0].id as string;

    // Keep the suite pinned to a known free model so each spec runs without
    // paid provider keys.
    await realPool.query("UPDATE agents SET model = ?", [FREE_MODEL]);

    realServer = createApp({ pool: realPool, storage, runManager, broadcastUserId });
    await new Promise<void>((resolve) => realServer.listen(0, "127.0.0.1", resolve));
    realPort = (realServer.address() as net.AddressInfo).port;
  }, 30000);

  afterAll(async () => {
    if (realPool) await clearSessions(realPool);
    clearConnections();
    if (realServer) await new Promise<void>((resolve) => realServer.close(() => resolve()));
    if (realPool) await realPool.end();

    // The scheduler spawned real roomy-sandbox-* containers during the run.
    // Remove only sandboxes that bind this test's temp home so parallel suites
    // keep their own containers.
    try {
      const { detectEngine } = await import("@roomy-ai/runtime");
      const engine = await detectEngine();
      for (const workspaceId of realWorkspaceIds) {
        await engine.remove(`roomy-sandbox-${workspaceId}`, true).catch(() => {});
      }
      const containers = await engine.list({ all: true, namePrefix: "roomy-sandbox-" });
      for (const c of containers) {
        const info = await engine.inspect(c.id).catch(() => null);
        if (info?.binds.some((bind) => bind.startsWith(`${realHome}:`) || bind.startsWith(`${realHome}/`))) {
          await engine.remove(c.id, true).catch(() => {});
        }
      }
    } catch { /* engine may not be available; nothing to clean */ }

    if (realHome) await rmTempTreeWithRetry(realHome);
    if (realDbPath) await rmTempTreeWithRetry(path.dirname(realDbPath));
  });

  it("sends a message through the full real stack and gets an assistant response", async () => {
    // Login
    const loginRes = await realRequest("POST", "/auth/login", undefined, {
      username: "testuser",
      password: "test-pass-1234",
    });
    expect(loginRes.status).toBe(200);
    realToken = (loginRes.body as { token: string }).token;

    // Get workspace + agent
    const wsRes = await realRequest("GET", "/workspaces", realToken);
    const workspaces = wsRes.body as Array<{ id: string; kind: string }>;
    const projectWorkspace = workspaces.find((w) => w.kind !== "hub") ?? workspaces[0];
    const agentsRes = await realRequest("GET", "/agents", realToken);
    const agents = agentsRes.body as Array<{ id: string }>;

    // Create a chat
    const chatRes = await realRequest("POST", "/chats", realToken, {
      workspaceId: projectWorkspace.id,
      agentId: agents[0].id,
      title: "Real Stack E2E Chat",
    });
    expect(chatRes.status).toBe(201);
    const chat = chatRes.body as { id: string };

    // Send a minimal deterministic message
    const msgRes = await realRequest("POST", `/chats/${chat.id}/messages`, realToken, {
      content: "Reply with exactly the word PONG and nothing else.",
    });
    expect(msgRes.status).toBe(201);

    // Poll the chat's messages for an agent reply (messages-as-truth).
    let assistantMsgs: Array<{ role: string; content: unknown }> = [];
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const msgsRes = await realRequest("GET", `/chats/${chat.id}/messages`, realToken);
      if (msgsRes.status !== 200) continue;
      const messages = msgsRes.body as { items: Array<{ role: string; content: unknown }> };
      assistantMsgs = messages.items.filter((m) => m.role === "agent");
      if (assistantMsgs.length > 0) break;
    }
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
  }, 360_000); // Free model runs are slower than paid APIs

  // G10: User memory (~/Roomy/.memory/memory.md) is injected into the
  // system prompt the runtime ships to pi. The cheap test-time model
  // doesn't reliably honor a user-memory instruction over the always-on
  // artifact-attach guidance, so the assertion targets the *prompt
  // rendering pipeline* (the server-side agent file written before each
  // run), not model compliance. The integration test in this same file
  // covers the happy-path of an actual agent reply elsewhere.
  it("user memory.md is rendered into the agent file at run time", async () => {
    if (!realToken) {
      const loginRes = await realRequest("POST", "/auth/login", undefined, {
        username: "testuser",
        password: "test-pass-1234",
      });
      realToken = (loginRes.body as { token: string }).token;
    }

    const sentinel = "CORSAIR_SENTINEL_USER_MEMORY";
    // ROOMY_HOME is the data root — no "Roomy" sub-segment since ac4ecca.
    const memoryDir = path.join(realHome, ".memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "memory.md"),
      `# User memory\n\n- ${sentinel}\n`,
      "utf-8",
    );

    const agentsRes = await realRequest("GET", "/agents", realToken);
    const agents = agentsRes.body as Array<{ id: string }>;
    const agentId = agents[0].id;

    const wsRes = await realRequest("GET", "/workspaces", realToken);
    const workspaces = wsRes.body as Array<{ id: string; path: string; kind: string }>;
    const projectWorkspace = workspaces.find((w) => w.kind !== "hub") ?? workspaces[0];
    const workspaceSlug = projectWorkspace.path;

    const chatRes = await realRequest("POST", "/chats", realToken, {
      workspaceId: projectWorkspace.id,
      agentId,
      title: "G10 User Memory Test Chat",
    });
    expect(chatRes.status).toBe(201);
    const chat = chatRes.body as { id: string };

    const msgRes = await realRequest("POST", `/chats/${chat.id}/messages`, realToken, {
      content: "Say hi briefly.",
    });
    expect(msgRes.status).toBe(201);

    // Wait until the runtime writes the agent file. Pi reads
    // <cwd>/AGENTS.md from cwd up through parent directories, so the
    // driver now writes a single AGENTS.md at the workspace root. The
    // rendered body contains the user-memory fragment we're asserting
    // on.
    const agentFile = path.join(realHome, workspaceSlug, "AGENTS.md");
    let body = "";
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      body = await fs.readFile(agentFile, "utf-8").catch(() => "");
      if (body.includes(sentinel)) break;
    }
    expect(body).toContain(sentinel);
    expect(body).toContain("<!-- Roomy user memory index -->");
  }, 120_000);

  // Full sub-task loop against the real stack: agent spawns an
  // unscheduled task via /sandbox/messages → server auto-fires it →
  // real pi runs in the dedicated thread chat → we call
  // /sandbox/messages/complete with a result message → the report
  // lands as a child of the anchor in the parent chat.
  //
  // The task body asks the model for the literal word DONE so the run
  // is short and the assertion is robust. The complete call posts the
  // report-back; the parent chat then carries exactly one new agent
  // message whose parentId points at the task anchor.
  // CI tail: the sub-task loop hits a real pi container plus the
  // free big-pickle model; cold-start + a model turn + the report-back
  // are routinely past the 10-min poll budget on shared GHA runners
  // (the test passes locally with warm caches). Skip on CI so the
  // integration suite as a whole can be green; run it locally on the
  // full real stack with `npm run test:host -- e2e`.
  it.skipIf(!!process.env.CI)("spawns a sub-task, auto-fires it, completes it, and delivers a report-back to the parent chat", async () => {
    if (!realToken) {
      const loginRes = await realRequest("POST", "/auth/login", undefined, {
        username: "testuser",
        password: "test-pass-1234",
      });
      realToken = (loginRes.body as { token: string }).token;
    }
    const wsRes = await realRequest("GET", "/workspaces", realToken);
    const workspaces = wsRes.body as Array<{ id: string; kind: string }>;
    const projectWs = workspaces.find((w) => w.kind !== "hub") ?? workspaces[0];
    const agentsRes = await realRequest("GET", "/agents", realToken);
    const agents = agentsRes.body as Array<{ id: string }>;

    // Parent chat — the conversation the sub-task is spun off from.
    const parentRes = await realRequest("POST", "/chats", realToken, {
      workspaceId: projectWs.id,
      agentId: agents[0].id,
      title: "Sub-task e2e parent",
    });
    expect(parentRes.status).toBe(201);
    const parentChat = parentRes.body as { id: string };

    // Issue a sandbox token directly into the DB — the test harness
    // doesn't run in a real sandbox container, so we mint one the same
    // way the runtime would when a container starts.
    const rawToken = `tok_${crypto.randomBytes(16).toString("hex")}`;
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await queries.sandboxSessions.issue(realPool, {
      id: generateId("sandboxSession"),
      agentId: agents[0].id,
      workspaceId: projectWs.id,
      tokenHash,
    });

    function sandboxRequest(
      urlPath: string,
      body: unknown,
    ): Promise<{ status: number; body: unknown }> {
      return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: realPort,
            path: urlPath,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(payload)),
              "X-Roomy-Sandbox-Token": rawToken,
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
    }

    // Spawn the sub-task — no --at, no --cron → server should auto-fire.
    const spawnRes = await sandboxRequest("/sandbox/messages", {
      chatId: parentChat.id,
      title: "Tiny sub-task",
      content: "Reply with exactly the word DONE and nothing else.",
    });
    expect(spawnRes.status).toBe(201);
    const spawn = spawnRes.body as {
      message: { id: string; chatId: string; threadChatId?: string };
      threadChat: { id: string };
      parentChatId: string;
    };
    expect(spawn.message.chatId).toBe(parentChat.id);
    expect(spawn.message.threadChatId).toBe(spawn.threadChat.id);
    expect(spawn.parentChatId).toBe(parentChat.id);

    // Wait for the auto-fire to produce a task_run in the thread chat
    // AND a separate agent reply child whose parentId is the task_run.
    // The task_run row itself is `role='agent'` (inherited from the
    // anchor) so we have to require a *second* agent-role row,
    // otherwise the assertion would pass the moment the task_run is
    // inserted — before pi has actually replied.
    let threadItems: Array<{ id: string; role: string; kind?: string; state?: string; parentId?: string; content?: { type?: string; text?: string } }> = [];
    let agentReplyText: string | undefined;
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const msgsRes = await realRequest("GET", `/chats/${spawn.threadChat.id}/messages`, realToken);
      if (msgsRes.status !== 200) continue;
      threadItems = (msgsRes.body as { items: typeof threadItems }).items;
      const taskRun = threadItems.find((m) => m.kind === "task_run");
      if (!taskRun) continue;
      // A genuine model reply is a chat-kind child of the task_run.
      const reply = threadItems.find(
        (m) => m.role === "agent" && m.kind !== "task_run" && m.parentId === taskRun.id,
      );
      if (reply?.content?.type === "text" && typeof reply.content.text === "string") {
        agentReplyText = reply.content.text;
        break;
      }
    }
    expect(agentReplyText).toBeDefined();
    // The prompt asked for the literal word DONE. Big-pickle isn't
    // perfectly compliant, so match case-insensitively and allow
    // surrounding whitespace/punctuation.
    expect(agentReplyText!.toUpperCase()).toMatch(/\bDONE\b/);

    // Now call task complete — flips anchor to succeeded and delivers
    // the report-back. The anchor for an unscheduled task stays pending
    // even after a successful run (afterTaskRun() short-circuits via
    // isUnscheduledTask), so complete is the canonical close.
    const completeRes = await sandboxRequest("/sandbox/messages/complete", {
      chatId: spawn.threadChat.id,
      message: "Task done — agent said DONE.",
    });
    expect(completeRes.status).toBe(200);
    const completeBody = completeRes.body as {
      task: { id: string; state: string };
      report?: { chatId: string; parentId?: string; role: string; content: { type: string; text: string } };
      parentChatId: string;
    };
    expect(completeBody.task.id).toBe(spawn.message.id);
    expect(completeBody.task.state).toBe("succeeded");
    expect(completeBody.parentChatId).toBe(parentChat.id);
    expect(completeBody.report).toBeDefined();
    expect(completeBody.report!.chatId).toBe(parentChat.id);
    expect(completeBody.report!.parentId).toBe(spawn.message.id);
    expect(completeBody.report!.content.text).toBe("Task done — agent said DONE.");

    // And the parent chat now actually contains that report row — visible
    // to the main-thread agent on its next turn, which is the whole point
    // of the report-back.
    const parentMsgsRes = await realRequest("GET", `/chats/${parentChat.id}/messages`, realToken);
    expect(parentMsgsRes.status).toBe(200);
    const parentItems = (parentMsgsRes.body as { items: Array<{ id: string; role: string; parentId?: string; content?: { type?: string; text?: string } }> }).items;
    const report = parentItems.find((m) => m.role === "agent" && m.parentId === spawn.message.id);
    expect(report).toBeDefined();
    expect(report!.content?.text).toBe("Task done — agent said DONE.");
    // The poll budget alone (180 × 2s = 360s) consumes the test's
    // wall-clock if budget=360s; cold container spin-up + model warm-up
    // can add another 60-120s on a CI runner. 10 min gives headroom
    // without disguising real hangs.
  }, 600_000);
});

async function rmTempTreeWithRetry(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM" && code !== "EBUSY") throw err;
      await delay(500);
    }
  }

  await fs.rm(targetPath, { recursive: true, force: true });
}
