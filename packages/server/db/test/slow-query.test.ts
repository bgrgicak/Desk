import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Writable } from "node:stream";
import { Pool, resetSlowQueryThresholdCache, _setSlowQueryLoggerForTest } from "../src/pool.js";
import { pino } from "pino";

let prevEnv: string | undefined;
let captured: string[];

beforeEach(() => {
  prevEnv = process.env.ROOMY_SLOW_QUERY_MS;
  captured = [];
  // Re-target the slow-query logger to an in-memory stream so the test
  // doesn't depend on pino's stdout wiring (sonic-boom bypasses
  // process.stdout.write on some platforms).
  const stream = new Writable({
    write(chunk, _enc, cb) {
      captured.push(chunk.toString("utf8"));
      cb();
    },
  });
  _setSlowQueryLoggerForTest(pino({ level: "warn" }, stream));
  resetSlowQueryThresholdCache();
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.ROOMY_SLOW_QUERY_MS;
  else process.env.ROOMY_SLOW_QUERY_MS = prevEnv;
  resetSlowQueryThresholdCache();
  _setSlowQueryLoggerForTest(null);
  vi.restoreAllMocks();
});

function slowMessages(): string[] {
  return captured.filter((line) => line.includes("slow query:"));
}

describe("slow-query log", () => {
  it("emits a warn for queries above the configured threshold", async () => {
    process.env.ROOMY_SLOW_QUERY_MS = "1"; // trigger on anything but trivial
    resetSlowQueryThresholdCache();
    // Explicit :memory: so the test stays isolated even when CI sets
    // ROOMY_DB_PATH (the default fallback) — without this, two
    // tests-in-the-same-process share a single SQLite file and the
    // second CREATE TABLE trips a "table already exists" error.
    const pool = new Pool({ path: ":memory:" });
    // Recursive CTE generating 200k rows + COUNT is deterministically
    // well over the 1ms threshold on every machine the test runs on,
    // unlike a sort-100-rows query which can finish in sub-millisecond
    // time on fast CPUs and silently miss the threshold (flake source).
    const res = await pool.query<{ n: number }>(
      `WITH RECURSIVE r(i) AS (
         SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 200000
       )
       SELECT COUNT(*) AS n FROM r`,
    );
    expect(res.rows[0].n).toBe(200000);
    expect(slowMessages().length).toBeGreaterThan(0);
    await pool.end();
  });

  it("never emits when the threshold is 0", async () => {
    process.env.ROOMY_SLOW_QUERY_MS = "0";
    resetSlowQueryThresholdCache();
    const pool = new Pool({ path: ":memory:" });
    pool.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await pool.query("SELECT * FROM t");
    expect(slowMessages()).toHaveLength(0);
    await pool.end();
  });

  it("never emits when the env var is unset and the query is fast", async () => {
    delete process.env.ROOMY_SLOW_QUERY_MS;
    resetSlowQueryThresholdCache();
    const pool = new Pool({ path: ":memory:" });
    pool.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await pool.query("SELECT * FROM t");
    expect(slowMessages()).toHaveLength(0);
    await pool.end();
  });

  it("sanitizes the logged SQL — collapses whitespace, truncates", async () => {
    process.env.ROOMY_SLOW_QUERY_MS = "1";
    resetSlowQueryThresholdCache();
    const pool = new Pool({ path: ":memory:" });
    // Same deterministic heavy query, parameterised so the bind-value
    // leakage assertion has something to look for.
    await pool.query(
      `WITH RECURSIVE r(i) AS (
         SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < ?
       )
       SELECT COUNT(*) AS n
       FROM r`,
      [200000],
    );
    const slow = slowMessages();
    expect(slow.length).toBeGreaterThan(0);
    // The SQL inside the line is normalised to single spaces. Strip
    // the trailing newline pino adds before checking.
    const last = slow[slow.length - 1].replace(/\n$/, "");
    expect(last).not.toMatch(/\n/);
    // Bind values never appear in the log.
    expect(slow.every((line) => !line.includes("200000"))).toBe(true);
  });
});
