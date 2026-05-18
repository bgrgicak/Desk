import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Pool } from "../src/pool.js";

let prevEnv: string | undefined;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  prevEnv = process.env.DESK_SLOW_QUERY_MS;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.DESK_SLOW_QUERY_MS;
  else process.env.DESK_SLOW_QUERY_MS = prevEnv;
  warnSpy.mockRestore();
});

function slowMessages(): string[] {
  return warnSpy.mock.calls
    .map((args) => args.map(String).join(" "))
    .filter((line) => line.startsWith("slow query:"));
}

describe("slow-query log", () => {
  it("emits a warn for queries above the configured threshold", async () => {
    process.env.DESK_SLOW_QUERY_MS = "1"; // trigger on anything but trivial
    const pool = new Pool(); // :memory:
    pool.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, payload TEXT)");
    pool.exec("BEGIN");
    for (let i = 0; i < 5000; i++) {
      await pool.query("INSERT INTO t (payload) VALUES (?)", [`row-${i}`]);
    }
    pool.exec("COMMIT");
    // Force a slow read by sorting the whole table.
    const res = await pool.query("SELECT * FROM t ORDER BY payload DESC LIMIT 100");
    expect(res.rows.length).toBe(100);
    // At least one slow-query line was emitted somewhere in the test.
    expect(slowMessages().length).toBeGreaterThan(0);
    await pool.end();
  });

  it("never emits when the threshold is 0", async () => {
    process.env.DESK_SLOW_QUERY_MS = "0";
    const pool = new Pool();
    pool.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await pool.query("SELECT * FROM t");
    expect(slowMessages()).toHaveLength(0);
    await pool.end();
  });

  it("never emits when the env var is unset and the query is fast", async () => {
    delete process.env.DESK_SLOW_QUERY_MS;
    const pool = new Pool();
    pool.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await pool.query("SELECT * FROM t");
    expect(slowMessages()).toHaveLength(0);
    await pool.end();
  });

  it("sanitizes the logged SQL — collapses whitespace, truncates", async () => {
    process.env.DESK_SLOW_QUERY_MS = "1";
    const pool = new Pool();
    pool.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, payload TEXT)");
    pool.exec("BEGIN");
    for (let i = 0; i < 5000; i++) {
      await pool.query("INSERT INTO t (payload) VALUES (?)", [`row-${i}`]);
    }
    pool.exec("COMMIT");
    await pool.query(`SELECT *
                      FROM t
                      WHERE payload LIKE ?
                      ORDER BY payload DESC`, ["row-%"]);
    const slow = slowMessages();
    expect(slow.length).toBeGreaterThan(0);
    // Whitespace is normalised to single spaces.
    expect(slow[slow.length - 1]).not.toMatch(/\n/);
    // Bind values never appear in the log.
    expect(slow.every((line) => !line.includes("row-"))).toBe(true);
    await pool.end();
  });
});
