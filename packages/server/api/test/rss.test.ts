import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations } from "@roomy-ai/db";
import { ensureLayout } from "@roomy-ai/storage";
import { createRunManager } from "@roomy-ai/scheduler";
import { createApp, type AppOptions } from "../src/app.js";
import { buildRssFeed } from "../src/routes/rss.js";

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

function fetchText(reqPath: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as net.AddressInfo).port;
    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-rss-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-rss-"));
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

describe("GET /feed.xml", () => {
  it("serves a public RSS feed", async () => {
    const res = await fetchText("/feed.xml");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/rss+xml");
    expect(res.body).toContain("<rss version=\"2.0\">");
    expect(res.body).toContain("<channel>");
    expect(res.body).toContain("<title>Roomy</title>");
  });

  it("also works through the /api prefix", async () => {
    const res = await fetchText("/api/feed.xml");

    expect(res.status).toBe(200);
    expect(res.body).toContain("<rss version=\"2.0\">");
  });
});

describe("buildRssFeed", () => {
  it("generates feed items from markdown documentation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-rss-content-"));
    try {
      await fs.mkdir(path.join(root, "packages/server/docs"), { recursive: true });
      await fs.writeFile(
        path.join(root, "packages/server/docs/API.md"),
        "# API Reference\n\nUse the Roomy HTTP API for workspace automation.",
      );

      const xml = await buildRssFeed({
        contentRoot: root,
        siteUrl: "https://example.test/",
        now: new Date("2026-05-27T00:00:00.000Z"),
      });

      expect(xml).toContain("<title>API Reference</title>");
      expect(xml).toContain("<link>https://example.test/packages/server/docs/API</link>");
      expect(xml).toContain("Use the Roomy HTTP API for workspace automation.");
      expect(xml).toContain("<lastBuildDate>Wed, 27 May 2026 00:00:00 GMT</lastBuildDate>");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
