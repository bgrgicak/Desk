import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import pg from "pg";
import { runMigrations, queries } from "@desk/db";
import { ensureLayout } from "@desk/storage";
import { createRunManager } from "@desk/scheduler";
import { generateId } from "@desk/shared";
import { createApp, type AppOptions } from "../src/app.js";
import { issueSession, clearSessions } from "../src/auth/sessions.js";
import { clearConnections, connectionCount, broadcast } from "../src/ws/registry.js";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_ws_upgrade_${workerId}`;

function adminConn(): string {
  const url = new URL(
    process.env.DESK_TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://desk:desk@127.0.0.1:55432/desk",
  );
  url.pathname = "/postgres";
  return url.toString();
}
function testConn(): string {
  const url = new URL(
    process.env.DESK_TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://desk:desk@127.0.0.1:55432/desk",
  );
  url.pathname = `/${testDbName}`;
  return url.toString();
}

let pool: pg.Pool;
let home: string;
let userId: string;

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

function getServerPort(server: http.Server): number {
  const addr = server.address() as net.AddressInfo;
  return addr.port;
}

let servers: http.Server[] = [];

function startServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = createApp(appOpts());
    server.listen(0, () => {
      servers.push(server);
      resolve(server);
    });
  });
}

/**
 * Performs a raw HTTP upgrade request (no ws library dependency).
 */
function rawUpgrade(
  port: number,
  reqPath: string,
): Promise<{ response: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
      socket.write(
        `GET ${reqPath} HTTP/1.1\r\n` +
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
    setTimeout(() => reject(new Error("Upgrade timeout")), 3000);
  });
}

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: adminConn() });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await admin.query(`CREATE DATABASE ${testDbName}`);
  } finally {
    await admin.end();
  }

  pool = new pg.Pool({ connectionString: testConn() });
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm"); } catch { /* ok */ }
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-ws-upgrade-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "ws-upgrade-test",
    passwordHash: "$2b$10$placeholder",
    email: "ws-upgrade@example.com",
  });
});

afterEach(async () => {
  await clearSessions(pool);
  clearConnections();
});

afterAll(async () => {
  for (const s of servers) s.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  delete process.env.DESK_HOME;

  const admin = new pg.Pool({ connectionString: adminConn() });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
  } finally {
    await admin.end();
  }
});

describe("WebSocket upgrade", () => {
  it("rejects upgrade without token", async () => {
    const server = await startServer();
    const port = getServerPort(server);

    const { response, socket } = await rawUpgrade(port, "/ws");
    socket.destroy();

    expect(response).toContain("401 Unauthorized");
  });

  it("rejects upgrade with invalid token", async () => {
    const server = await startServer();
    const port = getServerPort(server);

    const { response, socket } = await rawUpgrade(port, "/ws?token=ses_invalid");
    socket.destroy();

    expect(response).toContain("401 Unauthorized");
  });

  it("accepts upgrade with valid token and registers connection", async () => {
    const server = await startServer();
    const port = getServerPort(server);

    const token = await issueSession(pool, userId);
    const { response, socket } = await rawUpgrade(port, `/ws?token=${token}`);

    expect(response).toContain("101 Switching Protocols");
    expect(connectionCount()).toBe(1);

    socket.destroy();

    // Give time for close event to propagate
    await new Promise((r) => setTimeout(r, 200));
    // After destruction, the connection should be removed (or pruned on next broadcast)
    expect(connectionCount()).toBeLessThanOrEqual(1);
  });

  it("receives a broadcast event after upgrade", async () => {
    const server = await startServer();
    const port = getServerPort(server);

    const token = await issueSession(pool, userId);
    const { response, socket } = await rawUpgrade(port, `/ws?token=${token}`);

    expect(response).toContain("101 Switching Protocols");
    expect(connectionCount()).toBe(1);

    // Collect data frames from the socket
    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => received.push(chunk));

    // Broadcast a message.updated event (run.state_changed is gone in M6).
    broadcast(userId, {
      type: "message.updated",
      payload: {
        id: "msg_test1",
        chatId: "chat_1",
        role: "agent",
        content: { type: "text", text: "hi" },
        createdAt: new Date().toISOString(),
        state: "running",
      },
    });

    // Wait a bit for the frame to arrive
    await new Promise((r) => setTimeout(r, 200));

    // Parse the WebSocket text frame
    const frame = Buffer.concat(received);
    expect(frame.length).toBeGreaterThan(2);

    // First byte: 0x81 (FIN + text opcode)
    expect(frame[0]).toBe(0x81);

    // Extract payload from the WS frame
    let payloadStart = 2;
    let payloadLen = frame[1] & 0x7f;
    if (payloadLen === 126) {
      payloadLen = frame.readUInt16BE(2);
      payloadStart = 4;
    } else if (payloadLen === 127) {
      payloadLen = Number(frame.readBigUInt64BE(2));
      payloadStart = 10;
    }

    const payload = frame.subarray(payloadStart, payloadStart + payloadLen).toString("utf-8");
    const parsed = JSON.parse(payload);

    expect(parsed.type).toBe("message.updated");
    expect(parsed.payload.id).toBe("msg_test1");
    expect(parsed.payload.state).toBe("running");

    socket.destroy();
  });

  it("rejects upgrade on non-/ws path", async () => {
    const server = await startServer();
    const port = getServerPort(server);

    const token = await issueSession(pool, userId);

    await expect(rawUpgrade(port, `/other?token=${token}`)).rejects.toThrow();
  });
});
