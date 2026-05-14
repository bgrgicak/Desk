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
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startDeskServer, type DiskServer } from "./server";

const HANDLE_FILE = path.join(os.tmpdir(), "desk-app-e2e-handle.json");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..", "..");

interface StoredHandle {
  server: { pid: number; url: string; dbPath: string; home: string };
  vite: { pid: number; url: string };
  /** Path the spawned server reads for its host-managed Codex auth file. */
  codexAuthPath: string;
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

async function killListenersOnPort(port: number): Promise<void> {
  // Best-effort: kill anything still holding the port from a prior run.
  await new Promise<void>((resolve) => {
    const proc = spawn("bash", [
      "-c",
      // fuser is widely available; ss fallback is noisy but harmless.
      `fuser -k ${port}/tcp 2>/dev/null || true`,
    ]);
    proc.on("exit", () => resolve());
    setTimeout(() => resolve(), 2000);
  });
}

async function startVite(
  apiUrl: string,
  port: number,
): Promise<ChildProcess> {
  await killListenersOnPort(port);
  // Build once (inherits DESK_API_URL so the config closure captures it),
  // then run preview. Keep stderr/stdout piped so we can surface issues.
  // DESK_APP_PORT overrides the default 5173 baked into vite.config.ts.
  const env = {
    ...process.env,
    DESK_API_URL: apiUrl,
    DESK_APP_PORT: String(port),
  } as NodeJS.ProcessEnv;

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

  // Run vite directly from the installed binary — going via `npx` adds a
  // parent shell process whose PID we track in the teardown handle, but
  // the real vite process is a grandchild that outlives our SIGTERM and
  // keeps port 5179 busy for the next run.
  // npm workspaces may hoist vite to the repo root, so fall back there.
  const workspaceBin = path.join(APP_ROOT, "node_modules", ".bin", "vite");
  const rootBin = path.join(APP_ROOT, "..", "..", "node_modules", ".bin", "vite");
  const viteBin = existsSync(workspaceBin) ? workspaceBin : rootBin;
  const preview = spawn(
    viteBin,
    ["preview", "--logLevel", "warn"],
    { cwd: APP_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  // Always echo vite's own logs — if preview never binds (CI hosts
  // network sometimes regresses), the only post-mortem signal we have
  // is whatever vite said before we SIGKILL it.
  preview.stderr?.on("data", (b) => process.stderr.write(`[vite-err] ${b}`));
  preview.stdout?.on("data", (b) => process.stdout.write(`[vite-out] ${b}`));
  preview.on("error", (err) => process.stderr.write(`[vite-spawn-error] ${err.message}\n`));
  preview.on("exit", (code, signal) =>
    process.stderr.write(`[vite-exit] code=${code} signal=${signal}\n`),
  );
  return preview;
}

export async function globalSetup(): Promise<void> {
  // Pin the Codex auth path to a per-run tmp file so e2e tests can write
  // deterministic auth blobs without touching the developer's real
  // ~/.codex/auth.json (which would otherwise leak through `...process.env`).
  // The file does not need to exist up front — `getCodexAuthStatus` returns
  // `available: false` when missing, which is the expected default state.
  process.env.DESK_CODEX_AUTH_PATH = path.join(
    os.tmpdir(),
    `desk-app-e2e-codex-auth-${Date.now()}.json`,
  );

  const server = await startDeskServer({
    username: "e2e",
    password: "e2e",
  });
  // eslint-disable-next-line no-console
  console.log(`[e2e] desk-server up at ${server.url}`);

  const vitePort = Number(process.env.DESK_E2E_VITE_PORT ?? 5179);
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
      dbPath: server.dbPath,
      home: server.home,
    },
    vite: { pid: viteProc.pid ?? -1, url: viteUrl },
    codexAuthPath: process.env.DESK_CODEX_AUTH_PATH!,
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
  if (handle.server.dbPath) {
    await fs
      .rm(path.dirname(handle.server.dbPath), { recursive: true, force: true })
      .catch(() => undefined);
  }
  if (handle.server.home)
    await fs
      .rm(handle.server.home, { recursive: true, force: true })
      .catch(() => undefined);
  await fs.rm(HANDLE_FILE, { force: true }).catch(() => undefined);
}

// Keep references to avoid unused-symbol lint.
export type _DiskServer = DiskServer;
export default globalSetup;
