/**
 * Integration tests for the per-user secrets vault.
 *
 * Covers:
 *   - GET /vault/status returns exists/locked correctly
 *   - POST /vault/setup creates a fresh KDBX and leaves the vault unlocked
 *   - POST /vault/unlock with the right master unlocks; wrong master 401s
 *   - GET /secrets returns metadata only
 *   - POST /secrets writes; PUT /secrets/:title overwrites
 *   - GET /sandbox/secrets and GET /sandbox/secrets/:title return plaintext
 *     to a holder of a real sandbox token, scoped to that agent's user
 *   - When the vault is locked, every endpoint that needs the master
 *     returns 423 LOCKED
 *   - POST /auth/logout locks the vault for that user
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Pool } from "@roomy-ai/db";
import { runMigrations, insertSeedFixture, queries } from "@roomy-ai/db";
import { ensureLayout } from "@roomy-ai/storage";
import { generateId } from "@roomy-ai/shared";
import { createApp } from "../src/app.js";
import { ensureHubsForAllUsers } from "../src/routes/workspaces.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";
import { createRunManager } from "@roomy-ai/scheduler";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let userId: string;
let token: string;
let sandboxToken: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-vault-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  await insertSeedFixture(pool, { username: "vault-test", password: "vault-pass" });

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-vault-home-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;

  const storage = { pool, home };
  const runManager = createRunManager({
    pool,
    execRunFn: async (runId, _agentId, _prompt, onLog) => {
      await onLog({ runId, seq: 0, kind: "stdout", payload: "" });
      return { exitCode: 0 };
    },
  });

  const { rows: userRows } = await pool.query("SELECT id FROM users LIMIT 1");
  userId = userRows[0].id as string;

  // The hub PR requires sandbox sessions to carry a workspaceId; without one
  // the auth middleware throws 401 before vault checks run. Ensure each user
  // has a hub workspace so we can bind the sandbox token to it.
  await ensureHubsForAllUsers(pool, home);

  server = createApp({ pool, storage, runManager, broadcastUserId: userId });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  // Login.
  const login = await request("POST", "/auth/login", undefined, {
    email: "vault-test@roomy.local",
    password: "vault-pass",
  });
  token = (login.body as { token: string }).token;

  // Mint a sandbox token bound to a real agent owned by the user.
  // The vault routes resolve workspace-by-agent via the sandbox session,
  // and per-user scoping pivots on the agent's userId.
  const agentId = generateId("agent");
  await queries.agents.insert(pool, {
    id: agentId,
    userId,
    name: "vault-test-agent",
    instructions: "",
    model: "claude-sonnet-4-6",
  });
  const { rows: wsRows } = await pool.query(
    "SELECT id FROM workspaces WHERE user_id = ? LIMIT 1",
    [userId],
  );
  const workspaceId = wsRows[0]?.id as string;
  sandboxToken = "sb_" + crypto.randomBytes(16).toString("hex");
  await queries.sandboxSessions.issue(pool, {
    id: generateId("sbs"),
    agentId,
    workspaceId,
    tokenHash: crypto.createHash("sha256").update(sandboxToken).digest("hex"),
  });
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
  bearerOrSandbox?: { kind: "user"; token: string } | { kind: "sandbox"; token: string } | string | undefined,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (typeof bearerOrSandbox === "string") {
      headers["Authorization"] = `Bearer ${bearerOrSandbox}`;
    } else if (bearerOrSandbox?.kind === "user") {
      headers["Authorization"] = `Bearer ${bearerOrSandbox.token}`;
    } else if (bearerOrSandbox?.kind === "sandbox") {
      headers["X-Roomy-Sandbox-Token"] = bearerOrSandbox.token;
    }
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

describe("vault setup + unlock + status", () => {
  it("status before setup reports exists=false, locked=true", async () => {
    const res = await request("GET", "/vault/status", token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: false, locked: true });
  });

  it("setup creates a vault and leaves it unlocked", async () => {
    const res = await request("POST", "/vault/setup", token, { password: "correct horse battery staple" });
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    const status = await request("GET", "/vault/status", token);
    expect(status.body).toEqual({ exists: true, locked: false });
  });

  it("setup again fails because the file already exists", async () => {
    // Use a policy-compliant password so we exercise the conflict path,
    // not the password-policy validation that fires first.
    const res = await request("POST", "/vault/setup", token, { password: "another-strong-passphrase" });
    expect(res.status).toBe(409);
  });

  it("locking via POST /vault/lock relocks the vault", async () => {
    const lock = await request("POST", "/vault/lock", token, {});
    expect(lock.status).toBe(200);
    const status = await request("GET", "/vault/status", token);
    expect(status.body).toEqual({ exists: true, locked: true });
  });

  it("unlock with wrong password 401s and leaves the vault locked", async () => {
    const res = await request("POST", "/vault/unlock", token, { password: "WRONG" });
    expect(res.status).toBe(401);
    const status = await request("GET", "/vault/status", token);
    expect(status.body).toEqual({ exists: true, locked: true });
  });

  it("unlock with correct password unlocks", async () => {
    const res = await request("POST", "/vault/unlock", token, { password: "correct horse battery staple" });
    expect(res.status).toBe(200);
    const status = await request("GET", "/vault/status", token);
    expect(status.body).toEqual({ exists: true, locked: false });
  });
});

describe("secrets CRUD via user API", () => {
  it("starts with an empty list", async () => {
    const res = await request("GET", "/secrets", token);
    expect(res.status).toBe(200);
    expect((res.body as { secrets: unknown[] }).secrets).toEqual([]);
  });

  it("POST /secrets adds a secret; GET returns metadata only", async () => {
    const res = await request("POST", "/secrets", token, {
      title: "wordpress.org",
      username: "myuser",
      password: "p4ssw0rd!",
      url: "https://wordpress.org/wp-login.php",
      notes: "personal account",
    });
    expect(res.status).toBe(201);
    const list = await request("GET", "/secrets", token);
    const secrets = (list.body as { secrets: { title: string; username?: string; url?: string; hasNotes: boolean }[] }).secrets;
    expect(secrets).toHaveLength(1);
    expect(secrets[0].title).toBe("wordpress.org");
    expect(secrets[0].username).toBe("myuser");
    expect(secrets[0].url).toBe("https://wordpress.org/wp-login.php");
    expect(secrets[0].hasNotes).toBe(true);
    // No plaintext anywhere in the metadata view.
    expect(JSON.stringify(secrets[0])).not.toContain("p4ssw0rd!");
  });

  it("PUT /secrets/:title overwrites an existing entry", async () => {
    const res = await request("PUT", "/secrets/wordpress.org", token, {
      title: "wordpress.org",
      username: "myuser",
      password: "newp4ss",
      url: "https://wordpress.org/wp-login.php",
    });
    expect(res.status).toBe(200);
    const list = await request("GET", "/secrets", token);
    const secrets = (list.body as { secrets: { hasNotes: boolean }[] }).secrets;
    // Notes was omitted in the overwrite — no longer present.
    expect(secrets).toHaveLength(1);
    expect(secrets[0].hasNotes).toBe(false);
  });

  it("rejects POST without a title or password", async () => {
    const noTitle = await request("POST", "/secrets", token, { password: "x" });
    expect(noTitle.status).toBe(400);
    const noPassword = await request("POST", "/secrets", token, { title: "x" });
    expect(noPassword.status).toBe(400);
  });
});

describe("agent reads via /sandbox/secrets", () => {
  it("list returns titles + metadata for the agent's user", async () => {
    const res = await request("GET", "/sandbox/secrets", { kind: "sandbox", token: sandboxToken });
    expect(res.status).toBe(200);
    const secrets = (res.body as { secrets: { title: string }[] }).secrets;
    expect(secrets.map((s) => s.title)).toEqual(["wordpress.org"]);
  });

  it("get returns the full plaintext entry", async () => {
    const res = await request(
      "GET",
      "/sandbox/secrets/wordpress.org",
      { kind: "sandbox", token: sandboxToken },
    );
    expect(res.status).toBe(200);
    const secret = res.body as { title: string; username: string; password: string; url: string };
    expect(secret.title).toBe("wordpress.org");
    expect(secret.username).toBe("myuser");
    expect(secret.password).toBe("newp4ss");
    expect(secret.url).toBe("https://wordpress.org/wp-login.php");
  });

  it("get for an unknown title 404s", async () => {
    const res = await request(
      "GET",
      "/sandbox/secrets/does-not-exist",
      { kind: "sandbox", token: sandboxToken },
    );
    expect(res.status).toBe(404);
  });

  it("missing sandbox token 401s", async () => {
    const res = await request("GET", "/sandbox/secrets", undefined);
    expect(res.status).toBe(401);
  });
});

describe("locked vault → 423 on every endpoint that needs the master", () => {
  beforeAll(async () => {
    await request("POST", "/vault/lock", token, {});
  });

  it("GET /secrets returns 423", async () => {
    const res = await request("GET", "/secrets", token);
    expect(res.status).toBe(423);
    expect((res.body as { code: string }).code).toBe("VAULT_LOCKED");
  });

  it("POST /secrets returns 423", async () => {
    const res = await request("POST", "/secrets", token, { title: "t", password: "p" });
    expect(res.status).toBe(423);
  });

  it("PUT /secrets/:title returns 423", async () => {
    const res = await request("PUT", "/secrets/x", token, { title: "x", password: "p" });
    expect(res.status).toBe(423);
  });

  it("GET /sandbox/secrets returns 423", async () => {
    const res = await request("GET", "/sandbox/secrets", { kind: "sandbox", token: sandboxToken });
    expect(res.status).toBe(423);
  });

  it("GET /sandbox/secrets/:title returns 423", async () => {
    const res = await request("GET", "/sandbox/secrets/wordpress.org", { kind: "sandbox", token: sandboxToken });
    expect(res.status).toBe(423);
  });

  it("status still works (no master needed)", async () => {
    const res = await request("GET", "/vault/status", token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: true, locked: true });
  });
});

describe("logout locks the vault when no other sessions remain", () => {
  let extraToken: string;

  beforeAll(async () => {
    // Re-unlock so we can verify the lock-on-logout transition cleanly.
    await request("POST", "/vault/unlock", token, { password: "correct horse battery staple" });
    // Open a second session for the same user — logout of one shouldn't
    // lock the vault while the other is still alive.
    const login2 = await request("POST", "/auth/login", undefined, {
      email: "vault-test@roomy.local",
      password: "vault-pass",
    });
    extraToken = (login2.body as { token: string }).token;
  });

  it("logout of one session keeps the vault unlocked while another session exists", async () => {
    const res = await request("POST", "/auth/logout", extraToken, {});
    expect(res.status).toBe(200);
    const status = await request("GET", "/vault/status", token);
    expect(status.body).toEqual({ exists: true, locked: false });
  });

  it("logout of the last session locks the vault", async () => {
    const res = await request("POST", "/auth/logout", token, {});
    expect(res.status).toBe(200);
    // The token we just logged out is dead now, so we can't query
    // status with it. Re-login and check.
    const login = await request("POST", "/auth/login", undefined, {
      email: "vault-test@roomy.local",
      password: "vault-pass",
    });
    const fresh = (login.body as { token: string }).token;
    const status = await request("GET", "/vault/status", fresh);
    expect(status.body).toEqual({ exists: true, locked: true });
    // Restore for any later tests.
    token = fresh;
  });
});
