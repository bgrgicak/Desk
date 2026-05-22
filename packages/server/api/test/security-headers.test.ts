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
let baseUrl: string;

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

function fetchHeaders(method: string, reqPath: string, extraHeaders?: Record<string, string>): Promise<http.IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as net.AddressInfo).port;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, method, headers: extraHeaders },
      (res) => {
        res.on("data", () => undefined);
        res.on("end", () => resolve(res.headers));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-sec-headers-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-sec-headers-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;

  server = createApp(appOpts());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as net.AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.ROOMY_HOME;
});

describe("security headers", () => {
  it("sets nosniff, referrer-policy, permissions-policy on every response", async () => {
    const headers = await fetchHeaders("GET", "/openapi.json");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toMatch(/geolocation=\(\)/);
  });

  it("sets X-Frame-Options DENY on non-apps routes", async () => {
    const headers = await fetchHeaders("GET", "/openapi.json");
    expect(headers["x-frame-options"]).toBe("DENY");
  });

  it("omits X-Frame-Options on /apps/* so user apps stay embeddable", async () => {
    // /apps/* responds with 401 without an app token, but headers are
    // applied at the request entry before route dispatch, so the absence
    // of the header is still observable.
    const headers = await fetchHeaders("GET", "/apps/some-app-id/");
    expect(headers["x-frame-options"]).toBeUndefined();
  });

  it("omits HSTS on plain HTTP", async () => {
    const headers = await fetchHeaders("GET", "/openapi.json");
    expect(headers["strict-transport-security"]).toBeUndefined();
  });

  it("sets HSTS when X-Forwarded-Proto is https", async () => {
    const headers = await fetchHeaders("GET", "/openapi.json", { "X-Forwarded-Proto": "https" });
    expect(headers["strict-transport-security"]).toMatch(/max-age=\d+/);
  });

  it("applies headers to error responses too (e.g. 404)", async () => {
    const headers = await fetchHeaders("GET", "/definitely-not-a-route");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });
});
