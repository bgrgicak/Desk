/**
 * Playwright global setup: creates a test database, starts the API server,
 * builds the Vite app, and starts a combined server that serves both the
 * static app files and proxies API requests — all on one origin.
 */

import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations, seedIfEmpty } from "@desk/db";
import { ensureLayout } from "@desk/storage";
import { createMemoryAdapter, createRunManager } from "@desk/scheduler";
import { createApp, clearConnections, broadcast } from "@desk/api";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(APP_ROOT, "dist");
const STATE_FILE = path.join(APP_ROOT, "tests", ".test-state.json");

const SEED_USER = "testuser";
const SEED_PASS = "testpass";

function baseDbUrl(): string {
  return (
    process.env.DESK_TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://desk:desk@127.0.0.1:5432/desk"
  );
}

function adminUrl(): string {
  const u = new URL(baseDbUrl());
  u.pathname = "/postgres";
  return u.toString();
}

const TEST_DB_NAME = "desk_app_e2e_pw";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Paths that belong to the API (not static files)
const API_PREFIXES = [
  "/auth/",
  "/me",
  "/workspaces",
  "/agents",
  "/chats",
  "/library",
  "/runs",
  "/scheduled-jobs",
  "/search",
  "/openapi.json",
  "/ws",
];

function isApiPath(urlPath: string): boolean {
  for (const prefix of API_PREFIXES) {
    if (urlPath === prefix || urlPath.startsWith(prefix)) return true;
  }
  return false;
}

export default async function globalSetup() {
  // 1. Create test database
  const admin = new pg.Pool({ connectionString: adminUrl() });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB_NAME],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  } finally {
    await admin.end();
  }

  const dbUrl = new URL(baseDbUrl());
  dbUrl.pathname = `/${TEST_DB_NAME}`;
  const pool = new pg.Pool({ connectionString: dbUrl.toString() });
  // Prevent unhandled error crashes when the pool's connections are terminated
  pool.on("error", () => {});

  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  } catch {
    /* ok */
  }

  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = SEED_USER;
  process.env.DESK_SEED_PASSWORD = SEED_PASS;
  await seedIfEmpty(pool);

  // 2. Set up API server
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-app-e2e-"));
  await ensureLayout(home);

  const storage = { pool, home };
  const adapter = createMemoryAdapter();

  const { rows: userRows } = await pool.query("SELECT id FROM users LIMIT 1");
  const broadcastUserId = userRows[0].id as string;

  const runManager = createRunManager({
    pool,
    adapter,
    emit: (event) => broadcast(broadcastUserId, event),
    execRunFn: async (_runId, _agentId, _prompt, onLog) => {
      await onLog({
        runId: _runId,
        seq: 0,
        kind: "stdout",
        payload: "fake assistant response",
      });
      return { exitCode: 0 };
    },
  });

  const apiServer = createApp({ pool, storage, runManager, broadcastUserId });
  await new Promise<void>((resolve) =>
    apiServer.listen(0, "127.0.0.1", resolve),
  );
  const apiPort = (apiServer.address() as net.AddressInfo).port;

  // 3. Build the Vite app
  execSync("npx vite build", { cwd: APP_ROOT, stdio: "pipe" });

  // 4. Create combined server (static files + API proxy) on ephemeral port
  const combinedServer = http.createServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0];

    if (isApiPath(urlPath)) {
      // Proxy to API server
      const proxyReq = http.request(
        {
          hostname: "127.0.0.1",
          port: apiPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on("error", () => {
        res.writeHead(502);
        res.end("Bad gateway");
      });
      req.pipe(proxyReq);
      return;
    }

    // Serve static files
    let filePath = path.join(DIST_DIR, urlPath === "/" ? "index.html" : urlPath);
    if (!fsSync.existsSync(filePath)) {
      // SPA fallback
      filePath = path.join(DIST_DIR, "index.html");
    }

    const ext = path.extname(filePath);
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";

    try {
      const content = fsSync.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": mime });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  // Handle WebSocket upgrades by proxying to the API server
  combinedServer.on("upgrade", (req, socket, head) => {
    const proxySocket = net.createConnection(
      { host: "127.0.0.1", port: apiPort },
      () => {
        // Forward the original upgrade request
        let reqLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          reqLine += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        }
        reqLine += "\r\n";
        proxySocket.write(reqLine);
        if (head.length) proxySocket.write(head);

        // Bidirectional pipe
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
      },
    );
    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
  });

  await new Promise<void>((resolve) =>
    combinedServer.listen(0, "127.0.0.1", resolve),
  );
  const appPort = (combinedServer.address() as net.AddressInfo).port;

  // 5. Write state for tests to discover the port
  await fs.writeFile(
    STATE_FILE,
    JSON.stringify({ appPort, apiPort, testDbName: TEST_DB_NAME, home }),
  );

  // Return teardown function
  return async () => {
    clearConnections();
    combinedServer.close();
    apiServer.close();
    await pool.end();
    await fs.rm(home, { recursive: true, force: true });

    const adminPool = new pg.Pool({ connectionString: adminUrl() });
    try {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB_NAME],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    } finally {
      await adminPool.end();
    }

    try {
      await fs.unlink(STATE_FILE);
    } catch {
      /* ok */
    }
  };
}
