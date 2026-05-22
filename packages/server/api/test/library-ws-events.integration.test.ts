/**
 * Verifies that mutating library file content via the HTTP API emits the
 * corresponding `library.changed` WebSocket event to connected clients.
 *
 * This is the server half of the live-reload pipeline:
 *   PUT /library/content → server → WS broadcast → client re-fetches file
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
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-lib-ws-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  await insertSeedFixture(pool, { username: "testuser", password: "test-pass-1234" });

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-lib-ws-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;

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

/** Upload a text file to the library. Returns the file's server-assigned path. */
async function uploadFile(
  token: string,
  workspaceId: string,
  filename: string,
  content: string,
): Promise<string> {
  const boundary = `----roomy-test-${crypto.randomBytes(8).toString("hex")}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`,
    ),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const res = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/library?workspaceId=${encodeURIComponent(workspaceId)}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(body.length),
        },
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          resolve({ status: r.statusCode ?? 0, body: JSON.parse(raw) });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
  return (res.body as { path: string }).path;
}

/**
 * Open a raw WebSocket connection and return a helper that collects decoded
 * text-frame payloads. Server→client frames are never masked, so we can parse
 * them without a mask-key step.
 */
function openWs(token: string): Promise<{
  socket: net.Socket;
  messages: () => string[];
  destroy: () => void;
}> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const rawFrames: Buffer[] = [];
    const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
      socket.write(
        `GET /ws?token=${encodeURIComponent(token)} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
      );
    });

    let headersDone = false;
    let buf = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!headersDone) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        headersDone = true;
        buf = buf.subarray(idx + 4);
        resolve({
          socket,
          messages: () => decodeWsTextFrames(rawFrames),
          destroy: () => socket.destroy(),
        });
      }
      if (headersDone && buf.length > 0) {
        rawFrames.push(buf);
        buf = Buffer.alloc(0);
      }
    });

    socket.on("error", reject);
    setTimeout(() => reject(new Error("WS open timeout")), 5_000);
  });
}

/**
 * Minimal WebSocket text-frame decoder for server→client frames (no masking).
 * Handles payload lengths up to 65535 bytes (enough for our JSON events).
 */
function decodeWsTextFrames(chunks: Buffer[]): string[] {
  const combined = Buffer.concat(chunks);
  const results: string[] = [];
  let offset = 0;
  while (offset + 2 <= combined.length) {
    const opcode = combined[offset] & 0x0f;
    const isFin = (combined[offset] & 0x80) !== 0;
    const lenByte = combined[offset + 1] & 0x7f;
    let payloadLen = lenByte;
    let dataStart = offset + 2;

    if (lenByte === 126) {
      if (offset + 4 > combined.length) break;
      payloadLen = combined.readUInt16BE(offset + 2);
      dataStart = offset + 4;
    } else if (lenByte === 127) {
      if (offset + 10 > combined.length) break;
      payloadLen = Number(combined.readBigUInt64BE(offset + 2));
      dataStart = offset + 10;
    }

    if (dataStart + payloadLen > combined.length) break;

    if (opcode === 1 && isFin) {
      results.push(combined.subarray(dataStart, dataStart + payloadLen).toString("utf8"));
    }
    offset = dataStart + payloadLen;
  }
  return results;
}

async function putContent(
  token: string,
  workspaceId: string,
  filePath: string,
  content: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string; etag: string | null }> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(content);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
      "Content-Length": String(body.length),
      ...extraHeaders,
    };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/library/content?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(filePath)}`,
        method: "PUT",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            etag: res.headers["etag"] ?? null,
          });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function getContentWithEtag(
  token: string,
  workspaceId: string,
  filePath: string,
): Promise<{ body: string; etag: string | null }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/library/content?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(filePath)}`,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString(),
            etag: res.headers["etag"] ?? null,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("library ETag conflict detection", () => {
  it("GET /library/content returns an ETag header", async () => {
    const loginRes = await request("POST", "/auth/login", undefined, { email: "testuser@roomy.local", password: "test-pass-1234" });
    const token = (loginRes.body as { token: string }).token;
    const workspacesRes = await request("GET", "/workspaces", token);
    const workspaceId = (workspacesRes.body as Array<{ id: string }>)[0].id;

    const filePath = await uploadFile(token, workspaceId, `etag-get-${Date.now()}.txt`, "content");
    const { etag } = await getContentWithEtag(token, workspaceId, filePath);

    expect(etag).toBeTruthy();
  });

  it("PUT with matching If-Match succeeds", async () => {
    const loginRes = await request("POST", "/auth/login", undefined, { email: "testuser@roomy.local", password: "test-pass-1234" });
    const token = (loginRes.body as { token: string }).token;
    const workspacesRes = await request("GET", "/workspaces", token);
    const workspaceId = (workspacesRes.body as Array<{ id: string }>)[0].id;

    const filePath = await uploadFile(token, workspaceId, `etag-match-${Date.now()}.txt`, "original");
    const { etag } = await getContentWithEtag(token, workspaceId, filePath);

    const res = await putContent(token, workspaceId, filePath, "updated", { "If-Match": etag! });
    expect(res.status).toBe(200);
  });

  it("PUT with stale If-Match returns 409 and the current server content", async () => {
    const loginRes = await request("POST", "/auth/login", undefined, { email: "testuser@roomy.local", password: "test-pass-1234" });
    const token = (loginRes.body as { token: string }).token;
    const workspacesRes = await request("GET", "/workspaces", token);
    const workspaceId = (workspacesRes.body as Array<{ id: string }>)[0].id;

    const filePath = await uploadFile(token, workspaceId, `etag-conflict-${Date.now()}.txt`, "server version");

    const staleEtag = '"0"';
    const res = await putContent(token, workspaceId, filePath, "my edits", { "If-Match": staleEtag });

    expect(res.status).toBe(409);
    const body = JSON.parse(res.body) as { conflict: boolean; content: string; etag: string };
    expect(body.conflict).toBe(true);
    expect(body.content).toBe("server version");
    expect(body.etag).toBeTruthy();
  });
});

describe("library WebSocket events", () => {
  it("PUT /library/content emits library.changed with op=updated and the file path", async () => {
    const loginRes = await request("POST", "/auth/login", undefined, {
      email: "testuser@roomy.local",
      password: "test-pass-1234",
    });
    const token = (loginRes.body as { token: string }).token;

    const workspacesRes = await request("GET", "/workspaces", token);
    const workspaceId = (workspacesRes.body as Array<{ id: string }>)[0].id;

    const filename = `ws-event-test-${Date.now()}.txt`;
    const filePath = await uploadFile(token, workspaceId, filename, "initial content");

    // Connect WebSocket *before* the mutation so we receive the event.
    const ws = await openWs(token);

    const newContent = "updated content from test";
    const putRes = await request(
      "PUT",
      `/library/content?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(filePath)}`,
      token,
      undefined,
    );
    // PUT sends raw text, not JSON — redo with raw http
    await new Promise<void>((resolve, reject) => {
      const body = Buffer.from(newContent);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/library/content?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(filePath)}`,
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "text/plain",
            "Content-Length": String(body.length),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            expect(res.statusCode).toBe(200);
            resolve();
          });
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void putRes; // unused variable from earlier incorrect call — raw PUT above is authoritative

    // Allow a short window for the event to arrive over the socket.
    await new Promise((r) => setTimeout(r, 300));

    const received = ws.messages();
    ws.destroy();

    const libraryChangedEvents = received
      .map((raw) => {
        try { return JSON.parse(raw) as { type: string; payload: unknown }; } catch { return null; }
      })
      .filter((e): e is { type: string; payload: { path: string; op: string } } =>
        e?.type === "library.changed",
      );

    expect(libraryChangedEvents.length).toBeGreaterThan(0);

    const forOurFile = libraryChangedEvents.find((e) => e.payload.path === filePath);
    expect(forOurFile).toBeDefined();
    expect(forOurFile?.payload.op).toBe("updated");
  });
});
