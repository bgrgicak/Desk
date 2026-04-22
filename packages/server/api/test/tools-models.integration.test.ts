/**
 * End-to-end API test for GET /tools/models against a real sandbox.
 * Catches the kind of regression that only surfaces with real Docker + ESM +
 * real `opencode models` — e.g. CJS `require` calls leaking into ESM runtime.
 *
 * Gated on Docker availability so it runs in the VM but is skipped on hosts
 * without Docker.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { runMigrations, seedIfEmpty, seedProviderKeysFromEnv } from "@desk/db";
import { ensureLayout } from "@desk/storage";
import { createMemoryAdapter, createRunManager } from "@desk/scheduler";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !dockerAvailable();
const describeIf = SKIP ? describe.skip : describe;

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_tools_models_it_${workerId}`;

function baseUrl(): string {
  return process.env.DESK_TEST_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? "postgresql://desk:desk@127.0.0.1:55432/desk";
}
function adminConnectionString(): string {
  const url = new URL(baseUrl());
  url.pathname = "/postgres";
  return url.toString();
}
function testConnectionString(): string {
  const url = new URL(baseUrl());
  url.pathname = `/${testDbName}`;
  return url.toString();
}

let pool: pg.Pool;
let server: http.Server;
let port: number;
let home: string;
let token: string;
let createdAgentId: string | undefined;

beforeAll(async () => {
  if (SKIP) return;

  // Real Docker path: explicitly clear the fake driver.
  delete process.env.DESK_SANDBOX_DRIVER;

  const admin = new pg.Pool({ connectionString: adminConnectionString() });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await admin.query(`CREATE DATABASE ${testDbName}`);
  } finally {
    await admin.end();
  }

  pool = new pg.Pool({ connectionString: testConnectionString() });
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm"); } catch { /* ok */ }
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "testuser";
  process.env.DESK_SEED_PASSWORD = "testpass";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-tools-models-it-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  // Provider keys are user-scoped now (M2). Enable the dev-only env seed
  // so opencode inside the sandbox can see ANTHROPIC_API_KEY.
  process.env.DESK_DEV = "1";
  process.env.DESK_SECRET_KEY_PATH = path.join(home, "secret.key");
  await seedProviderKeysFromEnv(pool);

  const runManager = createRunManager({
    pool,
    adapter: createMemoryAdapter(),
    execRunFn: async (runId, _a, _p, onLog) => {
      onLog({ runId, seq: 0, kind: "stdout", payload: "noop" });
      return { exitCode: 0 };
    },
  });

  server = createApp({ pool, storage: { pool, home }, runManager });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  const loginRes = await httpJson("POST", "/auth/login", undefined, {
    username: "testuser",
    password: "testpass",
  });
  token = (loginRes.body as { token: string }).token;
}, 60_000);

afterAll(async () => {
  if (SKIP) return;
  clearSessions();
  clearConnections();
  server?.close();

  // Best-effort cleanup of any sandbox container we caused the API to spawn.
  // Sandboxes are keyed per-workspace now (M3), not per-agent.
  try {
    const { default: Docker } = await import("dockerode");
    const { dockerSocketPath } = await import("@desk/runtime");
    const docker = new Docker({ socketPath: dockerSocketPath() });
    const all = await docker.listContainers({ all: true });
    for (const c of all) {
      const name = (c.Names[0] ?? "").replace(/^\//, "");
      if (name.startsWith("desk-sandbox-wks_")) {
        const container = docker.getContainer(c.Id);
        await container.stop({ t: 2 }).catch(() => {});
        await container.remove({ force: true }).catch(() => {});
      }
    }
  } catch { /* ok */ }

  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });

  const admin = new pg.Pool({ connectionString: adminConnectionString() });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
  } finally {
    await admin.end();
  }
});

describeIf("GET /tools/models (real Docker + opencode)", () => {
  it("returns a bare array of { id, provider } from the real sandbox", async () => {
    // Capture the seeded agent id so cleanup knows which container we might have created.
    const agentsRes = await httpJson("GET", "/agents", token);
    createdAgentId = (agentsRes.body as Array<{ id: string }>)[0].id;

    const res = await httpJson("GET", "/tools/models", token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const body = res.body as Array<{ id: string; provider: string }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.some((m) => m.provider === "anthropic")).toBe(true);
    for (const m of body) {
      expect(m.id.startsWith(`${m.provider}/`)).toBe(true);
    }
  }, 90_000);

  it("?provider=anthropic returns only anthropic models", async () => {
    const res = await httpJson("GET", "/tools/models?provider=anthropic", token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const body = res.body as Array<{ id: string; provider: string }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((m) => m.provider === "anthropic")).toBe(true);
  }, 60_000);
});

function httpJson(
  method: string,
  urlPath: string,
  bearer?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
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
