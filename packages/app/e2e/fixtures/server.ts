import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPool, runMigrations, insertSeedFixture } from "@roomy-ai/db";

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

export interface RoomyServer {
  url: string;
  /** Filesystem path to the SQLite DB the spawned server is using. */
  dbPath: string;
  home: string;
  port: number;
  pid: number;
  stop(): Promise<void>;
}

export interface StartRoomyServerOptions {
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

/** Test fixture for the per-user vault. Keep separate from any UX-visible
 * default — operator-supplied passwords are no longer a thing. */
const E2E_VAULT_PASSWORD = "e2e-vault-password";

async function seedVault(
  serverUrl: string,
  username: string,
  loginPassword: string,
): Promise<void> {
  const email = `${username}@roomy.local`;
  const loginRes = await fetch(`${serverUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: loginPassword }),
  });
  if (loginRes.status !== 200) {
    throw new Error(
      `vault seed: login failed (${loginRes.status}): ${await loginRes.text()}`,
    );
  }
  const { token } = (await loginRes.json()) as { token: string };
  const setupRes = await fetch(`${serverUrl}/vault/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ password: E2E_VAULT_PASSWORD }),
  });
  if (setupRes.status !== 200) {
    throw new Error(
      `vault seed: setup failed (${setupRes.status}): ${await setupRes.text()}`,
    );
  }
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
  throw new Error(`roomy-server health check failed: ${String(lastErr)}`);
}

export async function startRoomyServer(
  opts: StartRoomyServerOptions = {},
): Promise<RoomyServer> {
  const runId =
    opts.runId ??
    `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`.replace(
      /[^a-z0-9_]/gi,
      "",
    );

  // Per-run sqlite file under a unique temp dir so parallel runs don't
  // trample each other.
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), `roomy-app-e2e-db-${runId}-`));
  const dbPath = path.join(dbDir, "test.sqlite3");

  const home = await fs.mkdtemp(path.join(os.tmpdir(), `roomy-app-e2e-${runId}-`));
  const port = await pickFreePort();

  // Seed the test user + first workspace + first agent BEFORE the server
  // starts. Production boot no longer auto-creates a "roomy" account
  // (the signup wizard owns that flow), so the e2e harness writes the
  // fixture directly into the per-run SQLite file. Migrations are
  // idempotent; running them here and again in main.ts is fine.
  const username = opts.username ?? "e2e";
  const password = opts.password ?? "e2e";
  {
    const pool = createPool({ path: dbPath });
    try {
      await runMigrations(pool);
      await insertSeedFixture(pool, { username, password });
    } finally {
      await pool.end();
    }
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    // The api server reads ROOMY_DB_PATH and creates the file on first
    // open via better-sqlite3. We pre-seeded the file above, so main.ts
    // boots straight into "one existing user" state.
    ROOMY_DB_PATH: dbPath,
    ROOMY_HOME: home,
    // ROOMY_SEED_USERNAME is still read by handleAutoLogin to pick which
    // user the auto-login should prefer — keep it in lockstep with the
    // seed call above for fixtures that flip ROOMY_AUTO_LOGIN back on.
    ROOMY_SEED_USERNAME: username,
    ROOMY_AUTO_LOGIN: "off",
    // Use the fake sandbox driver so task runs complete instantly without
    // needing Docker or API keys.
    ROOMY_SANDBOX_DRIVER: "fake",
    // Slow down each fake driver step so the page has time to observe
    // running=true before the agent turn completes. The spinner tests
    // (sidebar-running-spinner.spec.ts) rely on this window.
    ROOMY_FAKE_DRIVER_STEP_DELAY_MS: "500",
    // Poll every 2 s so scheduler e2e tests don't have to wait a full minute.
    ROOMY_SCHEDULER_POLL_INTERVAL_MS: "2000",
    // The current app UI bounces to `workspaces[0]` and expects the seeded
    // "Roomy" project workspace to live there. The hub workspace would sort
    // first if auto-created, breaking every test that selects the default
    // workspace. UI affordances for the hub are out of scope for this
    // change set — opt out at boot until the UI catches up.
    ROOMY_HUB_AUTO_CREATE: "off",
    ROOMY_FAKE_DRIVER_LOG_PROVIDER_KEYS: "1",
    // The e2e suite logs in for every spec, which makes the per-IP
    // auth.login rate-limit (10/min by default) fire and 429 later
    // tests. Disable rate limiting in the test fixture — production
    // never sets this.
    ROOMY_RATE_LIMIT_DISABLED: "1",
  };

  const child: ChildProcess = spawn("node", [SERVER_ENTRY], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Surface server logs — helpful when a test fails mysteriously.
  child.stdout?.on("data", (b: Buffer) => {
    if (process.env.ROOMY_E2E_VERBOSE)
      process.stdout.write(`[roomy-server] ${b}`);
  });
  child.stderr?.on("data", (b: Buffer) => {
    process.stderr.write(`[roomy-server] ${b}`);
  });

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(`${url}/`);
    // Seed the per-user vault via the API. Boot no longer auto-unlocks
    // (ROOMY_VAULT_PASSWORD was dropped), so each fresh server starts
    // with no vault. Set it up once here so every spec finds the same
    // "logged-in, vault unlocked" steady state the old env-driven
    // fixture produced. Specs that need a locked or absent vault should
    // call /vault/lock or run against their own server.
    await seedVault(url, username, password);
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
