/**
 * Gap 9: Multi-client WS sync — two WebSocket connections on the same session
 * both receive broadcast events when one mutates state via HTTP.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Pool } from "@roomy-ai/db";
import { runMigrations, insertSeedFixture } from "@roomy-ai/db";
import { ensureLayout } from "@roomy-ai/storage";
import { createRunManager } from "@roomy-ai/scheduler";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-multi-ws-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });

  await runMigrations(pool);
  await insertSeedFixture(pool, { username: "testuser", password: "test-pass-1234" });

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-multi-ws-"));
  await ensureLayout(home);

  const storage = { pool, home };
  const runManager = createRunManager({
    pool,
    execRunFn: async (_runId, _agentId, _prompt, onLog) => {
      onLog({ runId: _runId, seq: 0, kind: "stdout", payload: "ok" });
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

function openWs(token: string): Promise<{ socket: net.Socket; frames: Buffer[] }> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const frames: Buffer[] = [];
    const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
      socket.write(
        `GET /ws?token=${token} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `\r\n`,
      );
    });

    let headersDone = false;
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (!headersDone) {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx >= 0) {
          headersDone = true;
          const rest = buf.subarray(idx + 4);
          if (rest.length > 0) frames.push(rest);
          resolve({ socket, frames });
        }
      } else {
        frames.push(chunk);
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("WS open timeout")), 5000);
  });
}

describe("multi-client WS sync", () => {
  it("connection B receives event when connection A triggers a mutation via HTTP", async () => {
    // Login
    const loginRes = await request("POST", "/auth/login", undefined, {
      email: "testuser@roomy.local",
      password: "test-pass-1234",
    });
    const token = (loginRes.body as { token: string }).token;

    // Open two WS connections with the same session
    const wsA = await openWs(token);
    const wsB = await openWs(token);

    // Create a chat via HTTP (this emits no broadcast — but sending a message does)
    const wsRes = await request("GET", "/workspaces", token);
    const workspaces = wsRes.body as Array<{ id: string; kind: string }>;
    // Use the project workspace — hub sorts first after the Hub PR and this
    // test should validate that broadcasts work for ordinary project chats too.
    const projectWorkspace = workspaces.find((w) => w.kind !== "hub") ?? workspaces[0];
    const agentsRes = await request("GET", "/agents", token);
    const agents = agentsRes.body as Array<{ id: string }>;

    const chatRes = await request("POST", "/chats", token, {
      workspaceId: projectWorkspace.id,
      agentId: agents[0].id,
      title: "Multi WS Chat",
    });
    const chat = chatRes.body as { id: string };

    // Send a message — this triggers message.appended + run events via broadcast
    await request("POST", `/chats/${chat.id}/messages`, token, {
      content: "hello multi ws",
    });

    // Wait for events to arrive
    await new Promise((r) => setTimeout(r, 1000));

    // Both sockets should have received at least one frame
    const frameA = Buffer.concat(wsA.frames);
    const frameB = Buffer.concat(wsB.frames);
    expect(frameA.length).toBeGreaterThan(0);
    expect(frameB.length).toBeGreaterThan(0);

    wsA.socket.destroy();
    wsB.socket.destroy();
  });
});
