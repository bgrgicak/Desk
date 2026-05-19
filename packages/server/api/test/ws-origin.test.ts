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

describe("getAllowedWsOrigins env parsing", () => {
  it("returns DESK_ALLOWED_ORIGINS entries verbatim", async () => {
    const { getAllowedWsOrigins } = await import("../src/http/security-headers.js");
    const set = getAllowedWsOrigins({
      DESK_ALLOWED_ORIGINS: "https://desk.example.com,https://other.example.com",
      DESK_ALLOWED_HOSTS: "",
    });
    expect(set.has("https://desk.example.com")).toBe(true);
    expect(set.has("https://other.example.com")).toBe(true);
  });

  it("expands DESK_ALLOWED_HOSTS into http+https origin variants", async () => {
    // Without this, an operator with desk.test in /etc/hosts (the
    // documented nginx fixture default) gets 403 on every WS upgrade
    // because the browser sends Origin: https://desk.test which the
    // Vite-side env var alone doesn't tell the API process about.
    const { getAllowedWsOrigins } = await import("../src/http/security-headers.js");
    const set = getAllowedWsOrigins({
      DESK_ALLOWED_ORIGINS: "",
      DESK_ALLOWED_HOSTS: "desk.test,desk.local",
    });
    expect(set.has("http://desk.test")).toBe(true);
    expect(set.has("https://desk.test")).toBe(true);
    expect(set.has("http://desk.local")).toBe(true);
    expect(set.has("https://desk.local")).toBe(true);
  });

  it("defaults DESK_ALLOWED_HOSTS to desk.test when unset", async () => {
    const { getAllowedWsOrigins } = await import("../src/http/security-headers.js");
    const set = getAllowedWsOrigins({});
    expect(set.has("https://desk.test")).toBe(true);
    expect(set.has("http://desk.test")).toBe(true);
  });

  it("treats an explicitly empty DESK_ALLOWED_HOSTS as no hosts", async () => {
    const { getAllowedWsOrigins } = await import("../src/http/security-headers.js");
    const set = getAllowedWsOrigins({ DESK_ALLOWED_HOSTS: "" });
    expect(set.has("https://desk.test")).toBe(false);
  });
});

describe("isLoopbackAddress unit", () => {
  // Round-2 high-pri #5: the auto-login loopback check used to be a
  // hand-rolled equality on "127.0.0.1" / "::1" / "::ffff:127.0.0.1"
  // and missed the rest of 127.0.0.0/8.
  it("matches every host in 127.0.0.0/8", async () => {
    const { isLoopbackAddress } = await import("../src/http/security-headers.js");
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.0.0.2")).toBe(true);
    expect(isLoopbackAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackAddress("127.255.255.255")).toBe(true);
  });

  it("matches the IPv6 loopback shapes Node emits", async () => {
    const { isLoopbackAddress } = await import("../src/http/security-headers.js");
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.42.42.42")).toBe(true);
  });

  it("rejects non-loopback addresses", async () => {
    const { isLoopbackAddress } = await import("../src/http/security-headers.js");
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("8.8.8.8")).toBe(false);
    expect(isLoopbackAddress("::2")).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("rejects malformed-octet 127.x strings", async () => {
    // Cosmetic — Node won't emit invalid IPs as remoteAddress —
    // but tightening the regex stops the helper from silently
    // accepting "127.999.999.999" if anyone reuses it from a less-
    // trusted source.
    const { isLoopbackAddress } = await import("../src/http/security-headers.js");
    expect(isLoopbackAddress("127.999.999.999")).toBe(false);
    expect(isLoopbackAddress("127.0.0")).toBe(false);
    expect(isLoopbackAddress("127.0.0.1.5")).toBe(false);
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

  it("accepts upgrade with Origin: https://desk.test (default DESK_ALLOWED_HOSTS)", async () => {
    // Regression: user reported `wss://desk.test/ws … 403 Forbidden`
    // when running behind the bundled nginx fixture, because the
    // server-side allowlist used to only read DESK_ALLOWED_ORIGINS and
    // ignored the Vite-shared DESK_ALLOWED_HOSTS entirely.
    const { isWsOriginAllowed } = await import("../src/http/security-headers.js");
    expect(isWsOriginAllowed("https://desk.test")).toBe(true);
    expect(isWsOriginAllowed("http://desk.test")).toBe(true);
  });
});
