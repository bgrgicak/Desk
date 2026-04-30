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
import { Pool } from "@agent-desk/db";
import { runMigrations, seedIfEmpty, seedProviderKeysFromEnv } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createRunManager } from "@agent-desk/scheduler";
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

// Free opencode models are always present — no API key required.
// Gate only on Docker + sandbox image availability.
function sandboxImageAvailable(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", "desk/sandbox:v1"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_ANTHROPIC_KEY = !!process.env.ANTHROPIC_API_KEY;
const HAS_OPENAI_KEY = !!process.env.OPENAI_API_KEY;
const SKIP = !dockerAvailable() || !sandboxImageAvailable();
const describeIf = SKIP ? describe.skip : describe;

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let token: string;
let createdAgentId: string | undefined;

beforeAll(async () => {
  if (SKIP) return;

  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-tools-models-it-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "testuser";
  process.env.DESK_SEED_PASSWORD = "testpass";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-tools-models-it-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  // Provider keys are user-scoped now (M2). Enable the dev-only env seed
  // so opencode inside the sandbox can see ANTHROPIC_API_KEY / OPENAI_API_KEY.
  process.env.DESK_DEV = "1";
  process.env.DESK_SECRET_KEY_PATH = path.join(home, "secret.key");
  await seedProviderKeysFromEnv(pool);

  const runManager = createRunManager({
    pool,
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
  await clearSessions(pool);
  clearConnections();
  server?.close();

  // Best-effort cleanup of any sandbox container we caused the API to spawn.
  // Sandboxes are keyed per-workspace now (M3), not per-agent.
  try {
    const { default: Docker } = await import("dockerode");
    const { dockerSocketPath } = await import("@agent-desk/runtime");
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
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
});

describeIf("GET /tools/models (real Docker + opencode)", () => {
  it("returns a bare array of { id, provider } including free opencode models", async () => {
    // Capture the seeded agent id so cleanup knows which container we might have created.
    const agentsRes = await httpJson("GET", "/agents", token);
    createdAgentId = (agentsRes.body as Array<{ id: string }>)[0].id;

    const res = await httpJson("GET", "/tools/models", token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const body = res.body as Array<{ id: string; provider: string }>;
    expect(body.length).toBeGreaterThan(0);
    // Free opencode models must always be present — no API key required.
    expect(body.some((m) => m.provider === "opencode")).toBe(true);
    for (const m of body) {
      expect(m.id.startsWith(`${m.provider}/`)).toBe(true);
    }
  }, 90_000);

  it("?provider=opencode returns only opencode models", async () => {
    const res = await httpJson("GET", "/tools/models?provider=opencode", token);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const body = res.body as Array<{ id: string; provider: string }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((m) => m.provider === "opencode")).toBe(true);
  }, 60_000);

  // Paid-provider tests — skipped when the corresponding key is absent.
  const itIfAnthropic = HAS_ANTHROPIC_KEY ? it : it.skip;
  itIfAnthropic("?provider=anthropic returns only anthropic models", async () => {
    const res = await httpJson("GET", "/tools/models?provider=anthropic", token);
    expect(res.status).toBe(200);
    const body = res.body as Array<{ id: string; provider: string }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((m) => m.provider === "anthropic")).toBe(true);
  }, 60_000);

  const itIfOpenAI = HAS_OPENAI_KEY ? it : it.skip;
  itIfOpenAI("?provider=openai returns only openai models", async () => {
    const res = await httpJson("GET", "/tools/models?provider=openai", token);
    expect(res.status).toBe(200);
    const body = res.body as Array<{ id: string; provider: string }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((m) => m.provider === "openai")).toBe(true);
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
