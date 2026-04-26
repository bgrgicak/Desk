import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTestDatabase, dropTestDatabase, testDbUrl } from "./db";

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
  dbName: string;
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
  const dbName = `desk_app_e2e_${runId}`.toLowerCase();
  await createTestDatabase(dbName);

  const home = await fs.mkdtemp(path.join(os.tmpdir(), `desk-app-e2e-${runId}-`));
  const port = await pickFreePort();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    DATABASE_URL: testDbUrl(dbName),
    DESK_HOME: home,
    // The encryption module's default secret-key path is /home/desk/secret.key,
    // which the host user can't write to. Pin it inside DESK_HOME so the
    // /me/providers PUT path (encrypts keys) actually works under e2e.
    DESK_SECRET_KEY_PATH: path.join(home, "secret.key"),
    DESK_SEED_USERNAME: opts.username ?? "e2e",
    DESK_SEED_PASSWORD: opts.password ?? "e2e",
    // Host e2e runs without at/cron binaries (those live in the VM
    // path). Use the in-process adapter so scheduler-touching flows
    // (pause, resume, cancel) are exercised by the same test lane that
    // drives the UI.
    DESK_SCHEDULE_ADAPTER: "memory",
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
    await dropTestDatabase(dbName).catch(() => undefined);
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
    await dropTestDatabase(dbName).catch(() => undefined);
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  }

  return { url, dbName, home, port, pid: child.pid ?? -1, stop };
}
