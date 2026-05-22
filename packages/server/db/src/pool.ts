import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { withModule, type Logger } from "@roomy-ai/shared/logger";
let slowQueryLogger: Logger = withModule("db/pool");

/** Test-only: replace the slow-query logger with one whose destination
 * is observable. Pass `null` to restore the default. */
export function _setSlowQueryLoggerForTest(logger: Logger | null): void {
  slowQueryLogger = logger ?? withModule("db/pool");
}

export interface PoolConfig {
  /**
   * Filesystem path to the SQLite database. Falls back to ROOMY_DB_PATH and
   * finally to `:memory:` (test default). Use `:memory:` for unit tests
   * that don't need cross-connection visibility.
   */
  path?: string;
}

/**
 * Per-value parameter coercion. node:sqlite's bind types are JS
 * primitives + Buffer + null; the rest of the codebase emits booleans,
 * Dates, and undefined freely, so we adapt at the call boundary. SQL
 * itself is now plain SQLite — no translation here.
 */
function bindParam(p: unknown): null | number | bigint | string | NodeJS.ArrayBufferView {
  if (typeof p === "boolean") return p ? 1 : 0;
  if (p instanceof Date) return p.toISOString();
  if (p === undefined) return null;
  return p as null | number | bigint | string | NodeJS.ArrayBufferView;
}

interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * Threshold (ms) above which a query is logged as slow. Cached at
 * first read since execQuery is on the hot path and per-call
 * `process.env` lookups add non-trivial cost. Zero or NaN disables
 * logging entirely; the default is 50ms which surfaces the tail of
 * queries worth a closer look without flooding normal traffic.
 *
 * Logged shape: a single line with the elapsed time, row count and
 * the (sanitized) SQL — the SQL is the prepared statement text, with
 * normalised whitespace, never the bind values, so user content never
 * leaks into the log. PII redaction is the job of the values; the SQL
 * itself is fixed text.
 *
 * Tests that need to flip the env mid-process call
 * `resetSlowQueryThresholdCache()` so the next query re-reads.
 */
let slowQueryThresholdMsCache: number | undefined;
function resolveSlowQueryThresholdMs(): number {
  const raw = process.env.ROOMY_SLOW_QUERY_MS;
  if (raw === undefined) return 50;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function slowQueryThresholdMs(): number {
  if (slowQueryThresholdMsCache === undefined) {
    slowQueryThresholdMsCache = resolveSlowQueryThresholdMs();
  }
  return slowQueryThresholdMsCache;
}
export function resetSlowQueryThresholdCache(): void {
  slowQueryThresholdMsCache = undefined;
}

function logSlowQuery(elapsedMs: number, sql: string, rowCount: number): void {
  // Single-line, normalised whitespace so tail-friendly logs stay
  // grep-able. Truncated at 240 chars to avoid blowing up the log line
  // for unusually long generated SQL (search index rebuilds, etc.).
  const compact = sql.replace(/\s+/g, " ").trim().slice(0, 240);
  slowQueryLogger.warn(`slow query: ${elapsedMs}ms rows=${rowCount} sql=${compact}`);
}

function execQuery<T>(
  db: DatabaseSync,
  sql: string,
  params: unknown[] = [],
): QueryResult<T> {
  const bound = params.map(bindParam);
  const stmt = db.prepare(sql);
  const isReturning = /\bRETURNING\b/i.test(sql);
  const isSelect = /^\s*(WITH\b[\s\S]*?\bSELECT\b|SELECT\b)/i.test(sql);
  const threshold = slowQueryThresholdMs();
  const start = threshold > 0 ? performance.now() : 0;
  let result: QueryResult<T>;
  if (isSelect || isReturning) {
    const rows = stmt.all(...bound) as T[];
    result = { rows, rowCount: rows.length };
  } else {
    const info = stmt.run(...bound);
    result = { rows: [] as T[], rowCount: Number(info.changes) };
  }
  if (threshold > 0) {
    // Compare on the raw float — Math.round on a sub-millisecond elapsed
    // (e.g. 0.4ms) would collapse to 0 and silently drop the slow-query
    // signal even though the query was technically over the threshold
    // (which itself is an integer ms — anything ≥ threshold counts).
    const elapsed = performance.now() - start;
    if (elapsed >= threshold) logSlowQuery(Math.round(elapsed), sql, result.rowCount);
  }
  return result;
}

/**
 * SQLite-backed pool (backed by node:sqlite, the Node.js built-in).
 *
 * # Transaction model
 *
 * Transactions are SYNCHRONOUS. Use `transact(pool, fn)`; the callback
 * must not `await`. node:sqlite cannot guarantee atomicity across
 * async boundaries on a shared connection — the BEGIN/COMMIT sequence
 * happens on one connection, and any sibling handler's query lands on
 * the same connection while the event loop is yielded.
 *
 * For "read state, call external service, update state" patterns, do
 * NOT hold a transaction across the I/O. Use compare-and-swap:
 *
 *   const before = (await pool.query("SELECT state FROM x WHERE id=?", [id])).rows[0];
 *   const decision = await externalService(before);
 *   const { rowCount } = await pool.query(
 *     "UPDATE x SET state=? WHERE id=? AND state=?",
 *     [decision, id, before.state],
 *   );
 *   if (!rowCount) { // state changed under us — re-read or fail }
 *
 * Inside a `transact` callback, use `pool.querySync(...)` (sync).
 * Outside, use `pool.query(...)` (Promise).
 */
export class Pool {
  private readonly db: DatabaseSync;

  constructor(config?: PoolConfig) {
    // Resolution order: explicit `path` → `ROOMY_DB_PATH` env (production
    // default, set by install.sh) → `:memory:` (unit-test fallback).
    const path = config?.path ?? process.env.ROOMY_DB_PATH ?? ":memory:";
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    // EXCLUSIVE locking keeps the WAL index ("wal-index") in process heap
    // instead of an mmap'd `-shm` file. Two upsides for our
    // single-writer-process architecture (the API is the only thing that
    // opens this file; at/cron jobs route through /internal/messages/fire):
    //   1. Removes the mmap requirement on the underlying filesystem, so
    //      the DB stays portable across local FS / network mounts /
    //      bind-mounted volumes without changing the durability contract.
    //   2. Forces a single-opener invariant — a stray second process
    //      gets SQLITE_BUSY at open time instead of silently writing
    //      through a stale WAL view. Tests that simulate "server
    //      restart" close the existing pool before opening a fresh one.
    // Backup story: a host-side `sqlite3 .backup` CLI is blocked by the
    // exclusive lock, so the API exposes /internal/backup → VACUUM INTO
    // (runs on the live connection, no downtime). See BACKUP.md.
    // SQLite docs: https://www.sqlite.org/wal.html ("Use of WAL Without
    // Shared-Memory")
    this.db.exec("PRAGMA locking_mode=EXCLUSIVE");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA temp_store=MEMORY");

    // The DB holds password hashes, non-secret app metadata, and session
    // token hashes — anything that ends up readable to other
    // local users is a credential-disclosure incident. Force 0600 on the
    // file we just opened (and any pre-existing file we attached to);
    // skip for in-memory / non-real paths.
    if (path !== ":memory:" && !path.startsWith("file::memory:")) {
      try {
        chmodSync(path, 0o600);
      } catch {
        /* best-effort — racy with file creation, retried at next open */
      }
    }
  }

  /** Async query — for use OUTSIDE transactions. The result is already
   * synchronously available; the Promise wrapper keeps existing `await`
   * call sites unchanged. */
  query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return Promise.resolve(execQuery<T>(this.db, sql, params));
  }

  /** Sync query — for use INSIDE a `transact` callback. */
  querySync<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): QueryResult<T> {
    return execQuery<T>(this.db, sql, params);
  }

  async end(): Promise<void> {
    this.db.close();
  }

  /** Multi-statement script execution. */
  exec(sql: string): void {
    this.db.exec(sql);
  }
}

export function createPool(config?: PoolConfig): Pool {
  return new Pool(config);
}

/**
 * Excludes Promise from the callback's return type so async callbacks
 * fail to compile. The runtime check below is the second line of defense
 * (e.g. for callers using `as`-casts or untyped JavaScript).
 */
type Sync<T> = T extends Promise<unknown> ? never : T;

/**
 * Run `fn` inside a synchronous SQLite transaction (BEGIN IMMEDIATE).
 * The callback must be sync — see the file header for the rationale and
 * the compare-and-swap pattern for async I/O around state changes.
 *
 * On exception, the transaction is rolled back and the exception
 * propagates.
 */
export function transact<T>(pool: Pool, fn: (db: Pool) => Sync<T>): T {
  pool.exec("BEGIN IMMEDIATE");
  let result: Sync<T>;
  try {
    result = fn(pool);
  } catch (err) {
    try { pool.exec("ROLLBACK"); } catch { /* already in error state */ }
    throw err;
  }
  // Runtime guard: the Sync<T> type prevents Promise at compile time, but
  // `as`-casts in JS can sneak one through.
  if ((result as unknown) instanceof Promise) {
    try { pool.exec("ROLLBACK"); } catch { /* already in error state */ }
    throw new Error(
      "transact() callback must be synchronous — never `await` inside. " +
        "Move async work outside the transaction or use compare-and-swap. " +
        "See pool.ts header for the pattern.",
    );
  }
  pool.exec("COMMIT");
  return result;
}
