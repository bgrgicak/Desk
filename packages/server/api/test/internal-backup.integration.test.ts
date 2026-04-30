/**
 * Integration test for POST /internal/backup.
 *
 * Asserts the endpoint produces a real, complete SQLite copy of the live
 * DB on disk, lands at the configured path (default and override), and
 * rejects unauthenticated callers — all while the server's pool has the
 * source DB open with locking_mode=EXCLUSIVE.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@agent-desk/db";
import { runMigrations, seedIfEmpty } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createRunManager } from "@agent-desk/scheduler";
import { createApp } from "../src/app.js";
import { clearConnections } from "../src/ws/registry.js";
import { resetInternalTokenCache } from "../src/auth/internal.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let token: string;
let dbPath: string;

async function pickPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-backup-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "backup-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-backup-"));
  await ensureLayout(home);

  token = "x".repeat(64);
  const tokenPath = path.join(home, "internal-token");
  await fs.writeFile(tokenPath, token, { mode: 0o600 });
  process.env.DESK_INTERNAL_TOKEN_PATH = tokenPath;
  resetInternalTokenCache();

  const runManager = createRunManager({
    pool,
    execRunFn: async () => ({ exitCode: 0 }),
  });
  server = createApp({ pool, storage: { pool, home }, runManager });
  port = await pickPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
}, 30_000);

afterAll(async () => {
  clearConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
});

describe("POST /internal/backup", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/backup`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("produces a SQLite snapshot with the expected schema and contents", async () => {
    const dest = path.join(home, "snapshot.sqlite3");
    const res = await fetch(`http://127.0.0.1:${port}/internal/backup`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: dest }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; path: string; sizeBytes: number };
    expect(body.ok).toBe(true);
    expect(body.path).toBe(dest);
    expect(body.sizeBytes).toBeGreaterThan(0);

    // The backup is a real, openable SQLite DB with the same schema and
    // the seeded user row carried over. EXCLUSIVE locking on the source
    // doesn't block the backup; the destination is independent.
    const copy = new Pool({ path: dest });
    try {
      const { rows: tables } = await copy.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'",
      );
      expect(tables).toHaveLength(1);
      const { rows: users } = await copy.query<{ username: string }>(
        "SELECT username FROM users",
      );
      expect(users.map((u) => u.username)).toContain("backup-user");
    } finally {
      await copy.end();
    }
  });

  it("defaults destination to ${DESK_HOME}/Desk/backups/desk-<ts>.sqlite3", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/backup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { path: string };
    expect(body.path).toMatch(
      new RegExp(`^${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/Desk/backups/desk-[0-9-]+\\.sqlite3$`),
    );
    const stat = await fs.stat(body.path);
    expect(stat.size).toBeGreaterThan(0);
  });

  it("refuses to overwrite an existing destination file", async () => {
    const dest = path.join(home, "existing.sqlite3");
    await fs.writeFile(dest, "preexisting content");
    const res = await fetch(`http://127.0.0.1:${port}/internal/backup`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: dest }),
    });
    // VACUUM INTO throws SqliteError → mapped to 500 by the dispatcher.
    expect(res.status).toBeGreaterThanOrEqual(400);
    // Original file untouched.
    const buf = await fs.readFile(dest, "utf8");
    expect(buf).toBe("preexisting content");
  });
});
