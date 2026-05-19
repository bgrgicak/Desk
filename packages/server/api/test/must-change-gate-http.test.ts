/**
 * Regression coverage for the must-change-password HTTP gate
 * (round-2 critical #6) and the WS upgrade gate (round-2 critical
 * #1). Both refuse requests outside a small allowlist when the user
 * is still on the documented public seed credential.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hashPassword, Pool, runMigrations, queries } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId } from "@agent-desk/shared";
import { createApp, type AppOptions } from "../src/app.js";
import { issueSession, clearSessions } from "../src/auth/sessions.js";

let pool: Pool;
let home: string;
let userId: string;
let dbPath: string;
let server: http.Server;
let token: string;

function appOpts(): AppOptions {
  return {
    pool,
    storage: { pool, home },
    runManager: createRunManager({
      pool,
      execRunFn: async () => ({ exitCode: 0 }),
    }),
  };
}

function request(method: string, reqPath: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as net.AddressInfo).port;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));
    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, method, headers },
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

function rawWsUpgrade(reqPath: string): Promise<{ response: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as net.AddressInfo).port;
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
      if (response.includes("\r\n\r\n")) resolve({ response, socket });
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("Upgrade timeout")), 3000);
  });
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-mcp-gate-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-mcp-gate-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "mcg",
    passwordHash: "$2b$10$placeholder",
    email: "mcg@example.com",
  });
  // Force the flag on — simulates a fresh seed install whose operator
  // hasn't changed the seed password yet.
  await pool.query("UPDATE users SET must_change_password = 1 WHERE id = ?", [userId]);

  server = createApp(appOpts());
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

beforeEach(async () => {
  await clearSessions(pool);
  token = await issueSession(pool, userId);
});

afterAll(async () => {
  server.close();
  server.closeAllConnections?.();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
});

describe("must-change-password — HTTP gate", () => {
  it("allows GET /me (in the allowlist)", async () => {
    const res = await request("GET", "/me", { token });
    expect(res.status).toBe(200);
    expect((res.body as { mustChangePassword: boolean }).mustChangePassword).toBe(true);
  });

  it("allows POST /me/password (in the allowlist)", async () => {
    // Wrong current password → 401, NOT 403. That proves the gate
    // is letting the request through to the actual handler.
    const res = await request("POST", "/me/password", {
      token,
      body: { currentPassword: "wrong", newPassword: "a-strong-new-pw" },
    });
    expect([401]).toContain(res.status);
  });

  it("refuses GET /workspaces with 403 (NOT in the allowlist)", async () => {
    const res = await request("GET", "/workspaces", { token });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe("FORBIDDEN");
  });

  it("refuses POST /chats (state-changing, NOT in the allowlist)", async () => {
    const res = await request("POST", "/chats", { token, body: {} });
    expect(res.status).toBe(403);
  });
});

describe("must-change-password — /apps/* surface gate (PR review high #3)", () => {
  it("refuses POST /apps/chat/:cid/:appName/issue with 403 while gated", async () => {
    // /apps/* bypasses the global must-change middleware so static
    // dist serves don't re-run the gate per chunk, but
    // requireBearerForApps re-enforces it for any branch that
    // resolves the user's Bearer token (issue / DELETE / dist).
    const res = await request("POST", "/apps/chat/cht_test/myapp/issue", {
      token,
      body: {},
    });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe("FORBIDDEN");
  });

  it("refuses DELETE /apps/library/:appName with 403 while gated", async () => {
    const res = await request("DELETE", "/apps/library/myapp", { token });
    expect(res.status).toBe(403);
  });
});

describe("must-change-password — /me/password policy (PR review high #4)", () => {
  it("rejects a new password shorter than the 12-char minimum", async () => {
    const res = await request("POST", "/me/password", {
      token,
      body: { currentPassword: "wrong", newPassword: "short" },
    });
    // 400 here — the new-password policy check fires before the
    // current-password verification.  Without this guard, the gate
    // was defeatable by setting any throwaway value.
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("VALIDATION");
  });

  it("rejects the documented seed password verbatim", async () => {
    const res = await request("POST", "/me/password", {
      token,
      body: {
        currentPassword: "wrong",
        newPassword: "change-me-before-first-boot",
      },
    });
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toMatch(/seed password/i);
  });
});

describe("must-change-password — full round-trip", () => {
  // End-to-end of the entire gated flow against the real HTTP layer:
  //   1. user is gated, /workspaces 403s
  //   2. POST /me/password with the actual current password succeeds
  //   3. /me now reports mustChangePassword=false
  //   4. /workspaces is reachable again
  // Lives next to the other gate tests so a regression in any of the
  // four steps shows up under the same describe.
  it("clears the flag and unlocks the rest of the API after a valid password change", async () => {
    // Set a known current password we can use in the change call.
    // Direct DB update sidesteps the gate path itself — we want to
    // exercise change → unlock, not initial set.
    const currentPassword = "current-pw-strong-1";
    const hash = await hashPassword(currentPassword);
    await pool.query(
      "UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?",
      [hash, userId],
    );
    // Refresh the bearer so this test isn't reusing one from a prior it().
    token = await issueSession(pool, userId);

    // Step 1: confirm we start gated.
    const gatedMe = await request("GET", "/me", { token });
    expect(gatedMe.status).toBe(200);
    expect((gatedMe.body as { mustChangePassword: boolean }).mustChangePassword).toBe(true);
    const gatedWs = await request("GET", "/workspaces", { token });
    expect(gatedWs.status).toBe(403);

    // Step 2: change the password through the gate.
    const newPassword = "new-pw-very-strong-2";
    const changeRes = await request("POST", "/me/password", {
      token,
      body: { currentPassword, newPassword },
    });
    expect(changeRes.status).toBe(200);
    expect((changeRes.body as { ok: boolean }).ok).toBe(true);

    // Step 3: /me now reports the flag is gone.
    const ungatedMe = await request("GET", "/me", { token });
    expect(ungatedMe.status).toBe(200);
    expect((ungatedMe.body as { mustChangePassword: boolean }).mustChangePassword).toBe(false);

    // Step 4: the rest of the API is reachable again.
    const ungatedWs = await request("GET", "/workspaces", { token });
    expect(ungatedWs.status).toBe(200);

    // Restore the must-change flag so the other tests in this file
    // (which share the user) keep their preconditions.
    await pool.query("UPDATE users SET must_change_password = 1 WHERE id = ?", [userId]);
  });
});

describe("must-change-password — WS upgrade gate (round-2 critical #1)", () => {
  it("refuses the /ws upgrade with 403 while the flag is set", async () => {
    const { response, socket } = await rawWsUpgrade(`/ws?token=${token}`);
    socket.destroy();
    expect(response).toContain("403 Forbidden");
  });

  it("accepts the upgrade after the flag is cleared", async () => {
    await pool.query("UPDATE users SET must_change_password = 0 WHERE id = ?", [userId]);
    try {
      const { response, socket } = await rawWsUpgrade(`/ws?token=${token}`);
      socket.destroy();
      expect(response).toContain("101 Switching Protocols");
    } finally {
      // Restore for subsequent tests that re-use this user.
      await pool.query("UPDATE users SET must_change_password = 1 WHERE id = ?", [userId]);
    }
  });
});
