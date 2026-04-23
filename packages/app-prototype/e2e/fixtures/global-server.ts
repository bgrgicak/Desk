/**
 * Playwright global setup/teardown — boots a single disposable desk-server
 * for the whole run. Its URL is passed to the Vite dev server via
 * DESK_API_URL so /api proxies land on it instead of the developer's
 * local :3013.
 *
 * Cleanup handle is persisted to disk so `globalTeardown` can stop the
 * process even when module state is not shared across the two hooks.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dropTestDatabase } from "./db";
import { startDeskServer } from "./server";

const HANDLE_FILE = path.join(os.tmpdir(), "desk-app-e2e-handle.json");

interface StoredHandle {
  pid: number;
  url: string;
  dbName: string;
  home: string;
}

export async function globalSetup(): Promise<void> {
  const server = await startDeskServer({
    username: "e2e",
    password: "e2e",
  });

  process.env.DESK_API_URL = server.url;

  const handle: StoredHandle = {
    pid: server.pid,
    url: server.url,
    dbName: server.dbName,
    home: server.home,
  };
  await fs.writeFile(HANDLE_FILE, JSON.stringify(handle), "utf8");
}

export async function globalTeardown(): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(HANDLE_FILE, "utf8");
  } catch {
    return;
  }
  const handle = JSON.parse(raw) as StoredHandle;

  if (handle.pid > 0) {
    try {
      process.kill(handle.pid, "SIGTERM");
      await waitForExit(handle.pid, 5000);
    } catch {
      /* already dead */
    }
    try {
      process.kill(handle.pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }

  await dropTestDatabase(handle.dbName).catch(() => undefined);
  await fs.rm(handle.home, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(HANDLE_FILE, { force: true }).catch(() => undefined);
}

async function waitForExit(pid: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export default globalSetup;
