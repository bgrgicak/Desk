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
import { createApp, type AppOptions, isWsOriginAllowed } from "../src/app.js";
import { issueSession, clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let home: string;
let userId: string;
let dbPath: string;
let server: http.Server;

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

function rawUpgrade(port: number, reqPath: string, origin?: string): Promise<{ response: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
      const originLine = origin ? `Origin: ${origin}\r\n` : "";
      socket.write(
        `GET ${reqPath} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        originLine +
        `\r\n`,
      );
    });
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("\r\n\r\n")) resolve({ response, socket });
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("Upgrade timeout")), 3000);
  });
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-ws-origin-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-ws-origin-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "ws-origin-test",
    passwordHash: "$2b$10$placeholder",
    email: "ws-origin@example.com",
  });

  server = createApp(appOpts());
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

afterEach(async () => {
  await clearSessions(pool);
  clearConnections();
});

afterAll(async () => {
  // Don't wait for server.close — any still-open upgraded sockets keep the
  // close callback pending, and the OS reaps them when the vitest worker
  // exits anyway. Forcing the issue with closeAllConnections() requires
  // Node ≥18.2, which we have, but the existing ws-upgrade.test.ts uses
  // the fire-and-forget pattern so we match it.
  server.close();
  server.closeAllConnections?.();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
});

describe("isWsOriginAllowed unit", () => {
  const allowed = new Set<string>(["https://desk.example.com"]);

  it("returns true for an exactly-matched env-configured origin", () => {
    expect(isWsOriginAllowed("https://desk.example.com", allowed)).toBe(true);
  });

  it("returns true for a missing origin (non-browser client)", () => {
    expect(isWsOriginAllowed(undefined, allowed)).toBe(true);
    expect(isWsOriginAllowed("", allowed)).toBe(true);
  });

  it("returns true for any loopback origin regardless of port", () => {
    expect(isWsOriginAllowed("http://localhost:5173", allowed)).toBe(true);
    expect(isWsOriginAllowed("http://127.0.0.1:5179", allowed)).toBe(true);
    expect(isWsOriginAllowed("http://127.0.0.2:35138", allowed)).toBe(true); // 127.0.0.0/8
    expect(isWsOriginAllowed("http://localhost:35138", allowed)).toBe(true);
    expect(isWsOriginAllowed("https://localhost", allowed)).toBe(true);
    expect(isWsOriginAllowed("http://[::1]:8000", allowed)).toBe(true);
    expect(isWsOriginAllowed("http://[::ffff:127.0.0.1]:8000", allowed)).toBe(true);
  });

  it("returns false for an unknown non-loopback origin", () => {
    expect(isWsOriginAllowed("https://evil.example.com", allowed)).toBe(false);
    expect(isWsOriginAllowed("http://desk.example.com", allowed)).toBe(false); // wrong protocol
  });

  it("is case-sensitive on the origin string", () => {
    // Origin headers are sent verbatim by browsers; we deliberately do
    // not lowercase them. Matches the WHATWG behavior.
    expect(isWsOriginAllowed("HTTPS://DESK.EXAMPLE.COM", allowed)).toBe(false);
  });
});

describe("WebSocket upgrade — Origin allowlist (CSWSH mitigation)", () => {
  it("rejects upgrade with a cross-site Origin header", async () => {
    const port = (server.address() as net.AddressInfo).port;
    const token = await issueSession(pool, userId);
    const { response, socket } = await rawUpgrade(port, `/ws?token=${token}`, "https://evil.example.com");
    socket.destroy();
    expect(response).toContain("403 Forbidden");
  });

  it("accepts upgrade with a default-allowlisted Origin", async () => {
    const port = (server.address() as net.AddressInfo).port;
    const token = await issueSession(pool, userId);
    const { response, socket } = await rawUpgrade(port, `/ws?token=${token}`, "http://localhost:5173");
    socket.destroy();
    expect(response).toContain("101 Switching Protocols");
  });

  it("accepts upgrade with no Origin header at all", async () => {
    const port = (server.address() as net.AddressInfo).port;
    const token = await issueSession(pool, userId);
    const { response, socket } = await rawUpgrade(port, `/ws?token=${token}`);
    socket.destroy();
    expect(response).toContain("101 Switching Protocols");
  });

  it("rejects cross-site Origin even without a token (don't leak token validity)", async () => {
    const port = (server.address() as net.AddressInfo).port;
    const { response, socket } = await rawUpgrade(port, "/ws", "https://evil.example.com");
    socket.destroy();
    // Origin check runs before token check, so this is 403 not 401.
    expect(response).toContain("403 Forbidden");
  });
});
