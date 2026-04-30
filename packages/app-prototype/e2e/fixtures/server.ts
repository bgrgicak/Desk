import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SERVER_ENTRY = path.join(
  REPO_ROOT,
  "packages",
  "server",
  "api",
  "dist",
  "main.js",
);

export interface DiskServer {
  url: string;
  /** Filesystem path to the SQLite DB the spawned server is using. */
  dbPath: string;
  home: string;
  port: number;
  pid: number;
  stop(): Promise<void>;
}

export interface StartDeskServerOptions {
  username?: string;
  password?: string;
  runId?: string;
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address() as net.AddressInfo;
      const port = addr.port;
      s.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`desk-server health check failed: ${String(lastErr)}`);
}

export async function startDeskServer(
  opts: StartDeskServerOptions = {},
): Promise<DiskServer> {
  const runId =
    opts.runId ??
    `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`.replace(
      /[^a-z0-9_]/gi,
      "",
    );

  // Per-run sqlite file under a unique temp dir so parallel runs don't
  // trample each other.
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), `desk-app-e2e-db-${runId}-`));
  const dbPath = path.join(dbDir, "test.sqlite3");

  const home = await fs.mkdtemp(path.join(os.tmpdir(), `desk-app-e2e-${runId}-`));
  const port = await pickFreePort();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    // The api server reads DESK_DB_PATH and creates the file on first
    // open via better-sqlite3. No admin DB or migration ceremony needed
    // — main.ts runs migrations against an empty file the same way it
    // does in production.
    DESK_DB_PATH: dbPath,
    DESK_HOME: home,
    // The encryption module falls back to a key file when DESK_SECRET_KEY
    // is unset. Pin its path inside DESK_HOME so the /me/providers PUT
    // (which encrypts keys) actually works under e2e even without the
    // dev-launcher's .env writeback.
    DESK_SECRET_KEY_PATH: path.join(home, "secret.key"),
    DESK_SEED_USERNAME: opts.username ?? "e2e",
    DESK_SEED_PASSWORD: opts.password ?? "e2e",
    // Use the fake sandbox driver so task runs complete instantly without
    // needing Docker or API keys.
    DESK_SANDBOX_DRIVER: "fake",
    // Poll every 2 s so scheduler e2e tests don't have to wait a full minute.
    DESK_SCHEDULER_POLL_INTERVAL_MS: "2000",
  };

  const child: ChildProcess = spawn("node", [SERVER_ENTRY], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Surface server logs — helpful when a test fails mysteriously.
  child.stdout?.on("data", (b: Buffer) => {
    if (process.env.DESK_E2E_VERBOSE)
      process.stdout.write(`[desk-server] ${b}`);
  });
  child.stderr?.on("data", (b: Buffer) => {
    process.stderr.write(`[desk-server] ${b}`);
  });

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(`${url}/`);
  } catch (e) {
    child.kill("SIGKILL");
    await fs.rm(dbDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }

  async function stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3000);
    });
    await fs.rm(dbDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  }

  return { url, dbPath, home, port, pid: child.pid ?? -1, stop };
}
