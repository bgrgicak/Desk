/**
 * Integration coverage for local sources — model providers Desk auto-detects
 * on the user's host machine. Codex (ChatGPT subscription tokens) is the
 * first; LM Studio / Ollama will register the same way.
 *
 * Validates:
 *   - GET /me/providers/local enumerates every registered source with its
 *     detection status and the user's opt-in flag.
 *   - PUT /me/providers/local/:kind toggles opt-in (persisted in
 *     provider_meta) and the GET roundtrips it.
 *   - Unknown kinds return 404.
 *   - resolveLocalSourceEnv() — the helper used by the runtime — returns
 *     OPENCODE_AUTH_CONTENT iff the user is opted in *and* the host file
 *     is good.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@agent-desk/db";
import { runMigrations, seedIfEmpty } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";
import { createRunManager } from "@agent-desk/scheduler";
import { LOCAL_SOURCE_KINDS, resolveLocalSourceEnv } from "@agent-desk/runtime";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let codexAuthPath: string;

function jwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

function buildAuthFile(opts: { expSec?: number; email?: string; plan?: string; refresh?: string; account?: string } = {}) {
  const exp = opts.expSec ?? Math.floor(Date.now() / 1000) + 3600;
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({
        "https://api.openai.com/profile": { email: opts.email ?? "alice@example.com", email_verified: true },
        "https://api.openai.com/auth": {
          chatgpt_account_id: opts.account ?? "acct-test",
          chatgpt_plan_type: opts.plan ?? "pro",
        },
      }),
      access_token: jwt({ exp }),
      refresh_token: opts.refresh ?? "rt-test",
      account_id: opts.account ?? "acct-test",
    },
  };
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-local-sources-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "ls-test";
  process.env.DESK_SEED_PASSWORD = "ls-pass";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-local-sources-home-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;
  // Per-test fake — never touch the developer's real ~/.codex/auth.json.
  codexAuthPath = path.join(home, "codex-auth.json");
  process.env.DESK_CODEX_AUTH_PATH = codexAuthPath;

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
  delete process.env.DESK_CODEX_AUTH_PATH;
});

beforeEach(async () => {
  await fs.rm(codexAuthPath, { force: true });
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

describe("/me/providers/local", () => {
  let token: string;

  beforeAll(async () => {
    const login = await request("POST", "/auth/login", undefined, {
      username: "ls-test",
      password: "ls-pass",
    });
    token = (login.body as { token: string }).token;
  });

  it("requires authentication", async () => {
    const res = await request("GET", "/me/providers/local");
    expect(res.status).toBe(401);
  });

  it("lists every registered source — Codex shows reason=missing without a host file", async () => {
    const res = await request("GET", "/me/providers/local", token);
    expect(res.status).toBe(200);
    const sources = (res.body as { sources: Array<{ kind: string; available: boolean; reason?: string; enabled: boolean }> }).sources;
    expect(sources.map((s) => s.kind).sort()).toEqual([...LOCAL_SOURCE_KINDS].sort());
    const codex = sources.find((s) => s.kind === "codex");
    expect(codex).toBeDefined();
    expect(codex!.available).toBe(false);
    expect(codex!.enabled).toBe(false);
    expect(codex!.reason).toBe("missing");
  });

  it("surfaces detail (email, plan, expiresAt) when the host file is good", async () => {
    await fs.writeFile(codexAuthPath, JSON.stringify(buildAuthFile()));
    const res = await request("GET", "/me/providers/local", token);
    const codex = (res.body as { sources: Array<{ kind: string; available: boolean; detail?: Record<string, unknown> }> }).sources
      .find((s) => s.kind === "codex")!;
    expect(codex.available).toBe(true);
    expect(codex.detail?.email).toBe("alice@example.com");
    expect(codex.detail?.plan).toBe("pro");
    expect(typeof codex.detail?.expiresAt).toBe("number");
  });

  it("PUT toggles opt-in and roundtrips through GET", async () => {
    await fs.writeFile(codexAuthPath, JSON.stringify(buildAuthFile()));
    const enabled = await request("PUT", "/me/providers/local/codex", token, { enabled: true });
    expect(enabled.status).toBe(200);
    expect((enabled.body as { enabled: boolean }).enabled).toBe(true);

    const after = await request("GET", "/me/providers/local", token);
    const codex = (after.body as { sources: Array<{ kind: string; enabled: boolean }> }).sources
      .find((s) => s.kind === "codex")!;
    expect(codex.enabled).toBe(true);
  });

  it("rejects unknown source kinds with 404", async () => {
    const res = await request("PUT", "/me/providers/local/bogus", token, { enabled: true });
    expect(res.status).toBe(404);
  });

  it("rejects bodies without a boolean enabled field", async () => {
    const res = await request("PUT", "/me/providers/local/codex", token, {});
    expect(res.status).toBe(400);
  });
});

describe("resolveLocalSourceEnv", () => {
  let userId: string;
  let token: string;

  beforeAll(async () => {
    const { rows } = await pool.query("SELECT id FROM users LIMIT 1");
    userId = rows[0].id as string;
    const login = await request("POST", "/auth/login", undefined, {
      username: "ls-test",
      password: "ls-pass",
    });
    token = (login.body as { token: string }).token;
  });

  it("returns an empty map when no source is opted in", async () => {
    await fs.writeFile(codexAuthPath, JSON.stringify(buildAuthFile()));
    await request("PUT", "/me/providers/local/codex", token, { enabled: false });
    const env = await resolveLocalSourceEnv(pool, userId);
    expect(env).toEqual({});
  });

  it("returns OPENCODE_AUTH_CONTENT when Codex is opted in and the host file is good", async () => {
    await fs.writeFile(codexAuthPath, JSON.stringify(buildAuthFile({ refresh: "rt-bridge" })));
    await request("PUT", "/me/providers/local/codex", token, { enabled: true });
    const env = await resolveLocalSourceEnv(pool, userId);
    expect(typeof env.OPENCODE_AUTH_CONTENT).toBe("string");
    const blob = JSON.parse(env.OPENCODE_AUTH_CONTENT);
    expect(blob.openai.type).toBe("oauth");
    expect(blob.openai.refresh).toBe("rt-bridge");
    expect(blob.openai.accountId).toBe("acct-test");
  });

  it("returns an empty map when opted in but the host file is missing", async () => {
    await fs.rm(codexAuthPath, { force: true });
    await request("PUT", "/me/providers/local/codex", token, { enabled: true });
    const env = await resolveLocalSourceEnv(pool, userId);
    expect(env).toEqual({});
  });
});
