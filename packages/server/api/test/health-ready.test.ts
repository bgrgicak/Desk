import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations } from "@roomy-ai/db";
import { ensureLayout } from "@roomy-ai/storage";
import { createRunManager } from "@roomy-ai/scheduler";
import { createApp, type AppOptions } from "../src/app.js";

let pool: Pool;
let home: string;
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
  };
}

function fetchJson(method: string, reqPath: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as net.AddressInfo).port;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, method },
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
    req.end();
  });
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-health-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-health-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;

  server = createApp(appOpts());
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

afterAll(async () => {
  server.close();
  server.closeAllConnections?.();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.ROOMY_HOME;
});

describe("GET /health", () => {
  it("returns 200 ok regardless of dependency state", async () => {
    const res = await fetchJson("GET", "/health");
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  it("does not require authentication", async () => {
    const res = await fetchJson("GET", "/health");
    expect(res.status).toBe(200);
  });
});

describe("GET /ready", () => {
  it("returns 200 with per-dependency checks when DB + vault are responsive", async () => {
    const res = await fetchJson("GET", "/ready");
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; checks: Record<string, string> };
    expect(body.ok).toBe(true);
    expect(body.checks.db).toBe("ok");
    expect(body.checks.vault).toBe("ok");
  });

  it("does not require authentication", async () => {
    const res = await fetchJson("GET", "/ready");
    expect(res.status).toBe(200);
  });
});
