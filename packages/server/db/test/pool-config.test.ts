import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, transact } from "../src/pool.js";
import { runMigrations } from "../src/migrate.js";

let tmpDir: string;
const savedEnv = process.env.ROOMY_DB_PATH;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "roomy-pool-cfg-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.ROOMY_DB_PATH;
  else process.env.ROOMY_DB_PATH = savedEnv;
});

describe("pool path resolution", () => {
  it("opens the file at ROOMY_DB_PATH when no explicit path is passed", async () => {
    // Pre-fix regression: production main.ts called createPool with a
    // hardcoded postgres connection string, which routed to a tmp-file
    // via a now-deleted test compat shim and silently bypassed
    // ROOMY_DB_PATH. The DB ended up on tmpfs and was wiped between
    // restarts. We keep this test as a guardrail against regressions
    // in the resolution order.
    const dbPath = join(tmpDir, "roomy.db");
    process.env.ROOMY_DB_PATH = dbPath;

    const pool = createPool();
    await runMigrations(pool);
    await pool.end();

    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).size).toBeGreaterThan(0);
  });

  it("explicit path wins over ROOMY_DB_PATH (test isolation)", async () => {
    const envPath = join(tmpDir, "env.db");
    const explicitPath = join(tmpDir, "explicit.db");
    process.env.ROOMY_DB_PATH = envPath;

    const pool = createPool({ path: explicitPath });
    await runMigrations(pool);
    await pool.end();

    expect(existsSync(explicitPath)).toBe(true);
    expect(existsSync(envPath)).toBe(false);
  });
});

describe("transact", () => {
  it("prevents lost updates from overlapping callers", async () => {
    // Each `transact` runs synchronously to completion via
    // db.transaction(), so even when callers race through Promise.allSettled
    // they serialize at the engine layer (better-sqlite3 wraps the
    // callback in BEGIN/COMMIT before any other JS gets to run).
    const pool = createPool({ path: ":memory:" });
    pool.exec("CREATE TABLE counts (n INTEGER)");
    pool.querySync("INSERT INTO counts (n) VALUES (0)");

    const bump = (delta: number) =>
      transact(pool, (c) => {
        const { rows } = c.querySync<{ n: number }>("SELECT n FROM counts");
        c.querySync("UPDATE counts SET n = ?", [rows[0].n + delta]);
        return rows[0].n + delta;
      });

    const results = await Promise.allSettled([
      Promise.resolve().then(() => bump(1)),
      Promise.resolve().then(() => bump(2)),
      Promise.resolve().then(() => bump(2)),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toEqual([]);
    expect(pool.querySync<{ n: number }>("SELECT n FROM counts").rows[0].n).toBe(5);
    await pool.end();
  });

  it("rejects async callbacks at runtime", () => {
    // The Sync<T> type rejects async callbacks at compile time; this
    // covers `as`-cast / untyped escapes. Callers that try to hold a
    // tx across an `await` get a clear error pointing at the pattern
    // documented in pool.ts.
    const pool = createPool({ path: ":memory:" });
    expect(() =>
      transact(
        pool,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (async () => {}) as any,
      ),
    ).toThrow(/synchronous/);
    pool.end();
  });

  it("rolls back on thrown exception", () => {
    const pool = createPool({ path: ":memory:" });
    pool.exec("CREATE TABLE t (v INTEGER)");
    expect(() =>
      transact(pool, (c) => {
        c.querySync("INSERT INTO t VALUES (1)");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(pool.querySync<{ c: number }>("SELECT count(*) AS c FROM t").rows[0].c).toBe(0);
    pool.end();
  });
});
