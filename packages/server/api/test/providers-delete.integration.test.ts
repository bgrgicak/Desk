/**
 * Integration tests for removing a connection via PUT /me/providers with
 * null — the mechanism used by the UI's "Remove" action.
 *
 * Bug: the UI was sending '' (empty string) instead of null, which stored
 * the empty string rather than deleting the key, so the masked echo "****"
 * kept the connection visible.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@agent-desk/db";
import { runMigrations, seedIfEmpty, resetSecretKeyCache } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";
import { createRunManager } from "@agent-desk/scheduler";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-providers-del-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "prov-test";
  process.env.DESK_SEED_PASSWORD = "prov-pass";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-providers-del-home-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;
  process.env.DESK_SECRET_KEY_PATH = path.join(home, "secret.key");
  resetSecretKeyCache();

  const storage = { pool, home };
  const runManager = createRunManager({
    pool,
    execRunFn: async (_runId, _agentId, _prompt, onLog) => {
      await onLog({ runId: _runId, seq: 0, kind: "stdout", payload: "" });
      return { exitCode: 0 };
    },
  });

  const { rows: userRows } = await pool.query("SELECT id FROM users LIMIT 1");
  server = createApp({ pool, storage, runManager, broadcastUserId: userRows[0].id as string });
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

describe("PUT /me/providers — remove connection", () => {
  let token: string;

  beforeAll(async () => {
    const res = await request("POST", "/auth/login", undefined, {
      username: "prov-test",
      password: "prov-pass",
    });
    token = (res.body as { token: string }).token;
    // Provider keys now live in the vault — set it up and unlock it so the
    // PUT /me/providers tests can write keys.
    await request("POST", "/vault/setup", token, { password: "test-vault-pass" });
  });

  it("sending null removes the provider key so it no longer appears", async () => {
    // Save a key
    const setRes = await request("PUT", "/me/providers", token, {
      providers: { GEMINI_API_KEY: "gem-test-key-1234" },
    });
    expect(setRes.status).toBe(200);

    // Key should now appear (masked)
    const afterSet = await request("GET", "/me/providers", token);
    expect(afterSet.status).toBe(200);
    expect((afterSet.body as { providers: Record<string, string | null> }).providers.GEMINI_API_KEY).not.toBeNull();

    // Remove by sending null (the correct way)
    const delRes = await request("PUT", "/me/providers", token, {
      providers: { GEMINI_API_KEY: null },
    });
    expect(delRes.status).toBe(200);

    // Key must be gone
    const afterDel = await request("GET", "/me/providers", token);
    expect(afterDel.status).toBe(200);
    expect((afterDel.body as { providers: Record<string, string | null> }).providers.GEMINI_API_KEY).toBeNull();
  });

  it("sending empty string does NOT remove the key (documents current server contract)", async () => {
    // Save a key
    await request("PUT", "/me/providers", token, {
      providers: { OPENAI_API_KEY: "sk-oai-test-key-5678" },
    });

    // Send empty string — server stores it (non-null path in mergeProviderKeys)
    const emptyRes = await request("PUT", "/me/providers", token, {
      providers: { OPENAI_API_KEY: "" },
    });
    expect(emptyRes.status).toBe(200);

    // Key is present (stored as "") and masked echo is returned
    const afterEmpty = await request("GET", "/me/providers", token);
    expect((afterEmpty.body as { providers: Record<string, string | null> }).providers.OPENAI_API_KEY).not.toBeNull();

    // Clean up so other tests start fresh
    await request("PUT", "/me/providers", token, {
      providers: { OPENAI_API_KEY: null },
    });
  });
});
