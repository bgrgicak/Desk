/**
 * Playwright global setup/teardown — boots a single disposable desk-server
 * AND the Vite preview server for the whole run.
 *
 * Playwright's built-in `webServer` starts before globalSetup runs, which
 * means a closure in vite.config.ts (const API_TARGET = process.env.DESK_API_URL ?? …)
 * captures the wrong target. Starting both services from globalSetup
 * sequences them correctly: server first, then Vite with DESK_API_URL set
 * to the server's real URL.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dropTestDatabase } from "./db";
import { startDeskServer, type DiskServer } from "./server";

const HANDLE_FILE = path.join(os.tmpdir(), "desk-app-e2e-handle.json");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..", "..");

interface StoredHandle {
  server: { pid: number; url: string; dbName: string; home: string };
  vite: { pid: number; url: string };
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`health check failed for ${url}: ${String(lastErr)}`);
}

async function startVite(
  apiUrl: string,
  port: number,
): Promise<ChildProcess> {
  // Build once (inherits DESK_API_URL so the config closure captures it),
  // then run preview. Keep stderr/stdout piped so we can surface issues.
  const env = { ...process.env, DESK_API_URL: apiUrl } as NodeJS.ProcessEnv;

  await new Promise<void>((resolve, reject) => {
    const build = spawn(
      "npx",
      ["vite", "build", "--logLevel", "warn"],
      { cwd: APP_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    build.stderr?.on("data", (b) => (stderr += String(b)));
    build.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`vite build failed (${code}): ${stderr}`));
    });
  });

  const preview = spawn(
    "npx",
    [
      "vite",
      "preview",
      "--port",
      String(port),
      "--strictPort",
      "--logLevel",
      "warn",
    ],
    { cwd: APP_ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  preview.stderr?.on("data", (b) => process.stderr.write(`[vite-err] ${b}`));
  preview.stdout?.on("data", (b) => process.stdout.write(`[vite-out] ${b}`));
  preview.on("exit", (code, signal) =>
    process.stderr.write(`[vite-exit] code=${code} signal=${signal}\n`),
  );
  // Detach from the parent so Playwright's test runner doesn't kill it
  // when it restarts between tests in fullyParallel=false mode.
  preview.unref();
  return preview;
}

export async function globalSetup(): Promise<void> {
  const server = await startDeskServer({
    username: "e2e",
    password: "e2e",
  });
  // eslint-disable-next-line no-console
  console.log(`[e2e] desk-server up at ${server.url}`);

  const vitePort = 5179;
  const viteUrl = `http://127.0.0.1:${vitePort}`;
  const viteProc = await startVite(server.url, vitePort);
  // eslint-disable-next-line no-console
  console.log(`[e2e] vite preview up at ${viteUrl}, proxy → ${server.url}`);

  try {
    await waitForHealth(viteUrl);
  } catch (e) {
    viteProc.kill("SIGKILL");
    await server.stop();
    throw e;
  }

  const handle: StoredHandle = {
    server: {
      pid: server.pid,
      url: server.url,
      dbName: server.dbName,
      home: server.home,
    },
    vite: { pid: viteProc.pid ?? -1, url: viteUrl },
  };
  await fs.writeFile(HANDLE_FILE, JSON.stringify(handle), "utf8");
  // Let the test fixtures find the URLs.
  process.env.DESK_API_URL = server.url;
  process.env.DESK_E2E_APP_URL = viteUrl;

  // We can't use closures across setup/teardown reliably, but the PIDs give
  // teardown everything it needs.
}

export async function globalTeardown(): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(HANDLE_FILE, "utf8");
  } catch {
    return;
  }
  const handle = JSON.parse(raw) as StoredHandle;

  for (const pid of [handle.vite.pid, handle.server.pid]) {
    if (!pid || pid <= 0) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  }
  // Give them a moment.
  await new Promise((r) => setTimeout(r, 500));
  for (const pid of [handle.vite.pid, handle.server.pid]) {
    if (!pid || pid <= 0) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
  if (handle.server.dbName)
    await dropTestDatabase(handle.server.dbName).catch(() => undefined);
  if (handle.server.home)
    await fs
      .rm(handle.server.home, { recursive: true, force: true })
      .catch(() => undefined);
  await fs.rm(HANDLE_FILE, { force: true }).catch(() => undefined);
}

// Keep references to avoid unused-symbol lint.
export type _DiskServer = DiskServer;
export default globalSetup;
