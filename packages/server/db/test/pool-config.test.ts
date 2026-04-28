import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, withTx } from "../src/pool.js";
import { runMigrations } from "../src/migrate.js";

let tmpDir: string;
const savedEnv = process.env.DESK_DB_PATH;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "desk-pool-cfg-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.DESK_DB_PATH;
  else process.env.DESK_DB_PATH = savedEnv;
});

describe("pool path resolution", () => {
  it("opens the file at DESK_DB_PATH when no explicit path/connectionString is passed", async () => {
    // Pre-fix regression: production main.ts called createPool with a
    // hardcoded `connectionString`, which routed to a tmp-file via the
    // test compat shim and silently bypassed DESK_DB_PATH. The DB
    // ended up on tmpfs and was wiped on every vm:reset.
    const dbPath = join(tmpDir, "desk.db");
    process.env.DESK_DB_PATH = dbPath;

    const pool = createPool();
    await runMigrations(pool);
    await pool.end();

    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).size).toBeGreaterThan(0);
  });

  it("explicit path wins over DESK_DB_PATH (test isolation)", async () => {
    const envPath = join(tmpDir, "env.db");
    const explicitPath = join(tmpDir, "explicit.db");
    process.env.DESK_DB_PATH = envPath;

    const pool = createPool({ path: explicitPath });
    await runMigrations(pool);
    await pool.end();

    expect(existsSync(explicitPath)).toBe(true);
    expect(existsSync(envPath)).toBe(false);
  });

  it("connectionString shim wins over DESK_DB_PATH (test isolation)", async () => {
    // CI sets DESK_DB_PATH for the production code path. Tests that
    // pass a connectionString rely on the per-string temp file for
    // isolation — without this precedence every CI integration test
    // would share one DB and trip over each other.
    const envPath = join(tmpDir, "env.db");
    process.env.DESK_DB_PATH = envPath;

    const pool = createPool({
      connectionString: "postgresql:///desk?host=/var/run/postgresql",
    });
    await runMigrations(pool);
    await pool.end();

    // The shim opens a hashed temp file under os.tmpdir(); DESK_DB_PATH
    // is untouched.
    expect(existsSync(envPath)).toBe(false);
  });
});

describe("pool concurrent transactions", () => {
  it("serializes overlapping withTx callers", async () => {
    // Pre-fix regression: the second caller threw "Nested transactions
    // are not supported" because beginTx was synchronous and the JS-level
    // guard had no queue. The pool now serializes via a FIFO so callers
    // wait for the current owner to commit/rollback.
    const pool = createPool({ path: ":memory:" });
    pool.exec("CREATE TABLE counts (n INTEGER)");
    await pool.query("INSERT INTO counts (n) VALUES (0)");

    const bump = (delta: number) =>
      withTx(pool, async (c) => {
        const { rows } = await c.query<{ n: number }>("SELECT n FROM counts");
        await c.query("UPDATE counts SET n = $1", [rows[0].n + delta]);
        return rows[0].n + delta;
      });

    // Without serialization, both reads see 0 → final count is 1, not 5.
    const results = await Promise.allSettled([
      bump(1),
      bump(2),
      bump(2),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toEqual([]);
    const { rows } = await pool.query<{ n: number }>("SELECT n FROM counts");
    expect(rows[0].n).toBe(5);
    await pool.end();
  });
});
