/**
 * Regression — multi-user WS broadcast.
 *
 * Before the recipient-resolver work, the server picked one
 * `broadcastUserId` at boot (`SELECT id FROM users LIMIT 1`) and fanned
 * every WS event to that single account. Users created later via the
 * signup wizard saw zero live updates (live observation: send a message
 * in Ask AI or any room, the bubble didn't appear until reload), because
 * their sockets were registered under their own userId while events
 * were broadcast to the seed user only.
 *
 * This spec stands the bug back up: create two users, log in as the
 * second one, send a message to their chat, and assert a real WS frame
 * arrives on the second user's socket. Failing here means we regressed
 * back to the single-user broadcast path.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Pool, runMigrations, queries } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId } from "@agent-desk/shared";
import { createApp } from "../src/app.js";
import { issueSession, clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";
import { clearRecipientCaches } from "../src/ws/recipient.js";

let pool: Pool;
let home: string;
let dbPath: string;
let server: http.Server;
let port: number;

/** The seed (first) user — the legacy `broadcastUserId` pick at boot. */
let firstUserId: string;
/** A second user, created after the first — used to be silently dropped. */
let secondUserId: string;
let secondWorkspaceId: string;
let secondAgentId: string;
let secondChatId: string;

function rawUpgrade(reqPath: string): Promise<{ response: string; socket: net.Socket }> {
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
    socket.on("data", function captureHandshake(chunk) {
      response += chunk.toString();
      if (response.includes("\r\n\r\n")) {
        socket.off("data", captureHandshake);
        resolve({ response, socket });
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("Upgrade timeout")), 3000);
  });
}

/** Decode one or more text frames from a raw socket buffer. */
function decodeTextFrames(buffer: Buffer): string[] {
  const out: string[] = [];
  let offset = 0;
  while (offset < buffer.length - 1) {
    const opcode = buffer[offset] & 0x0f;
    if (opcode !== 0x1 && opcode !== 0x0) break; // text or continuation
    let payloadLen = buffer[offset + 1] & 0x7f;
    let payloadStart = offset + 2;
    if (payloadLen === 126) {
      if (buffer.length < offset + 4) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      payloadStart = offset + 4;
    } else if (payloadLen === 127) {
      if (buffer.length < offset + 10) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      payloadStart = offset + 10;
    }
    if (buffer.length < payloadStart + payloadLen) break;
    out.push(buffer.subarray(payloadStart, payloadStart + payloadLen).toString("utf-8"));
    offset = payloadStart + payloadLen;
  }
  return out;
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-ws-multi-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-ws-multi-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  // Seed the FIRST user — this is the row `SELECT id FROM users LIMIT 1`
  // used to pick, so any regression to the old broadcast path would
  // fan events to *this* user instead of the second one.
  firstUserId = generateId("user");
  await queries.users.insert(pool, {
    id: firstUserId,
    username: "first",
    passwordHash: "$2b$10$placeholder",
    email: "first@example.com",
  });

  // Then a second user with its own workspace + agent + chat. Order
  // matters: this user must come AFTER the first so the legacy
  // boot-time SELECT would have skipped them entirely.
  secondUserId = generateId("user");
  await queries.users.insert(pool, {
    id: secondUserId,
    username: "second",
    passwordHash: "$2b$10$placeholder",
    email: "second@example.com",
  });
  secondWorkspaceId = generateId("workspace");
  await queries.workspaces.insert(pool, {
    id: secondWorkspaceId,
    userId: secondUserId,
    path: "second-room",
    name: "Second Room",
  });
  secondAgentId = generateId("agent");
  await queries.agents.insert(pool, {
    id: secondAgentId,
    userId: secondUserId,
    name: "Second Agent",
    model: "anthropic/claude-haiku-4-5",
  });
  await queries.workspaceAgents.addToWorkspace(pool, secondWorkspaceId, secondAgentId);
  secondChatId = generateId("chat");
  await queries.chats.insert(pool, {
    id: secondChatId,
    workspaceId: secondWorkspaceId,
    agentId: secondAgentId,
    title: "Second Chat",
  });

  // No broadcastUserId — the resolver derives the recipient from each
  // event's workspaceId/chatId. Passing broadcastUserId=firstUserId
  // here is what produced the bug; this test deliberately omits it.
  server = createApp({
    pool,
    storage: { pool, home },
    runManager: createRunManager({
      pool,
      execRunFn: async () => ({ exitCode: 0 }),
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterEach(async () => {
  await clearSessions(pool);
  clearConnections();
  clearRecipientCaches();
});

afterAll(async () => {
  server.close();
  server.closeAllConnections?.();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
});

describe("WS broadcast resolves the recipient per event (multi-user)", () => {
  it("delivers a message.appended frame to the SECOND user's socket when they POST to their own chat", async () => {
    const token = await issueSession(pool, secondUserId);
    const { response, socket } = await rawUpgrade(`/ws?token=${token}`);
    expect(response).toContain("101 Switching Protocols");

    try {
      const frames: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => frames.push(chunk));

      // POST a chat message AS the second user. Pre-fix: emit looked up
      // opts.broadcastUserId (unset → silent return); WS frame never
      // arrives; this assertion would fail on a 3 s timeout.
      const postResult = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const body = JSON.stringify({ content: "hello from the second user" });
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: `/chats/${secondChatId}/messages`,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              Authorization: `Bearer ${token}`,
            },
          },
          (res) => {
            let buf = "";
            res.on("data", (c) => (buf += c.toString()));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf }));
          },
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });
      expect(postResult.status).toBe(201);

      // Give the async emit chain a tick to derive the recipient and
      // hand the event off to the broadcast registry.
      const deadline = Date.now() + 3000;
      let messagesAppended: string[] = [];
      while (Date.now() < deadline) {
        const decoded = decodeTextFrames(Buffer.concat(frames));
        messagesAppended = decoded.filter((f) => f.includes("message.appended"));
        if (messagesAppended.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(
        messagesAppended.length,
        `expected at least one message.appended frame for the second user; got ${messagesAppended.length}. raw=${Buffer.concat(frames).toString("utf-8").slice(0, 400)}`,
      ).toBeGreaterThan(0);
      const parsed = JSON.parse(messagesAppended[0]);
      expect(parsed.payload.content.text).toBe("hello from the second user");
    } finally {
      socket.destroy();
    }
  });

  it("does NOT deliver the second user's event to a socket opened by the first user", async () => {
    // Two sockets, two tokens. The first user owns no chat in this
    // suite, but they could still pop a WS for "my dashboard" etc. The
    // event for second-user activity must not leak across accounts.
    const firstToken = await issueSession(pool, firstUserId);
    const secondToken = await issueSession(pool, secondUserId);
    const { socket: firstSocket } = await rawUpgrade(`/ws?token=${firstToken}`);
    const { socket: secondSocket } = await rawUpgrade(`/ws?token=${secondToken}`);

    try {
      const firstFrames: Buffer[] = [];
      const secondFrames: Buffer[] = [];
      firstSocket.on("data", (c: Buffer) => firstFrames.push(c));
      secondSocket.on("data", (c: Buffer) => secondFrames.push(c));

      const body = JSON.stringify({ content: "isolation check" });
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: `/chats/${secondChatId}/messages`,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              Authorization: `Bearer ${secondToken}`,
            },
          },
          (res) => {
            res.on("data", () => {});
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });

      // Wait for the second user to receive the event.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const decoded = decodeTextFrames(Buffer.concat(secondFrames));
        if (decoded.some((f) => f.includes("isolation check"))) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const secondDecoded = decodeTextFrames(Buffer.concat(secondFrames));
      expect(secondDecoded.some((f) => f.includes("isolation check"))).toBe(true);

      // And the first user — who owns nothing in this chat — must have
      // received zero text frames for that activity.
      const firstDecoded = decodeTextFrames(Buffer.concat(firstFrames));
      expect(firstDecoded.some((f) => f.includes("isolation check"))).toBe(false);
    } finally {
      firstSocket.destroy();
      secondSocket.destroy();
    }
  });
});
