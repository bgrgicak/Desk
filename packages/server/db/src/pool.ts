import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database, { type Database as BetterSqlite3Db } from "better-sqlite3";

export interface PoolConfig {
  /**
   * Filesystem path to the SQLite database. Falls back to DESK_DB_PATH and
   * finally to `:memory:` (test default). Use `:memory:` for unit tests
   * that don't need cross-connection visibility.
   */
  path?: string;
  /**
   * Test-only compatibility shim: tests written against the previous
   * Postgres setup pass a `postgresql://…` connection string here. The
   * value is hashed into a per-process temp file so two pools opened
   * with the same connection string see the same database (preserves
   * the "fresh pool against the same DB" pattern). Production must
   * pass `path` directly — passing a `connectionString` here silently
   * routes the DB to /tmp regardless of DESK_DB_PATH.
   */
  connectionString?: string;
}

/**
 * Translates the small subset of Postgres-specific SQL idioms the codebase
 * uses into their SQLite equivalents. Anything else passes through.
 *
 * Per-table semantics (JSON parsing on read, boolean column conversions)
 * live in the per-table `rowToX` functions, where the schema knowledge is.
 */
/**
 * Translates a Postgres-style SQL string into SQLite-flavored SQL and
 * remaps the positional parameter list to match.
 *
 * `$N` placeholders are translated to `?`, but SQLite's `?` is positional
 * (parameters bind in the textual order the `?` appears) while Postgres's
 * `$N` is by-index — so a query that writes `$1` after `$2` would bind
 * the wrong values if we just did a substring swap. Returning a remapped
 * params array alongside the SQL keeps the wrapper a faithful drop-in.
 */
function translateSqlAndParams(
  sql: string,
  params: unknown[],
): { sql: string; params: unknown[] } {
  // Pre-pass: tests that pre-date the SQLite migration still wrap their
  // setup in Postgres admin queries (CREATE DATABASE, pg_terminate_backend,
  // etc.). Treat those as no-ops so the legacy setup blocks keep running
  // — the actual data lives in the per-worker :memory: SQLite handle, so
  // the admin pool's bookkeeping has nothing to do.
  if (
    /\b(?:CREATE|DROP)\s+DATABASE\b/i.test(sql) ||
    /\bpg_terminate_backend\b/i.test(sql) ||
    /\bpg_stat_activity\b/i.test(sql) ||
    /\bpg_catalog\b/i.test(sql) ||
    /\bpg_database\b/i.test(sql) ||
    /\bpg_roles\b/i.test(sql) ||
    /\bCREATE\s+EXTENSION\b/i.test(sql) ||
    /\bSET\s+TIME\s+ZONE\b/i.test(sql)
  ) {
    return { sql: "SELECT 1 WHERE 0", params: [] };
  }

  // Walk $N occurrences in textual order, build the remapped params
  // array, and substitute each with `?`.
  const remapped: unknown[] = [];
  const translated = sql.replace(/\$(\d+)/g, (_, n) => {
    const idx = Number(n) - 1;
    remapped.push(params[idx]);
    return "?";
  });

  // `now() ± interval 'N units' [± interval 'M units' ...]` →
  // SQLite's strftime modifier form. Chain runs of intervals into a
  // single strftime call so `now() - interval '7 days' - interval '1 second'`
  // stays one expression. Modifiers compose left-to-right in strftime.
  const intervalUnit =
    "(seconds?|minutes?|hours?|days?|weeks?|months?|years?)";
  const intervalRe = new RegExp(
    String.raw`\bnow\(\)((?:\s*[+-]\s*interval\s*'\d+\s+` + intervalUnit +
      String.raw`')+)`,
    "gi",
  );
  const finalSql = translated.replace(intervalRe, (_, chain: string) => {
    const mods: string[] = [];
    const partRe = new RegExp(
      String.raw`([+-])\s*interval\s*'(\d+)\s+` + intervalUnit + String.raw`'`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = partRe.exec(chain)) !== null) {
      mods.push(`'${m[1]}${m[2]} ${m[3].toLowerCase()}'`);
    }
    return `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${mods.join(", ")})`;
  })
    // bare now() → ISO 8601 UTC string matching JS Date.toISOString().
    // ms precision so cursors and "ORDER BY created_at, id" stay stable
    // when multiple inserts land within the same millisecond.
    .replace(/\bnow\(\)/gi, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
    // FOR UPDATE / FOR SHARE: SQLite's WAL mode + IMMEDIATE transactions
    // serialize writers automatically; explicit row locks have no analog
    // and would be a syntax error.
    .replace(/\bFOR\s+UPDATE\b/gi, "")
    .replace(/\bFOR\s+SHARE\b/gi, "")
    // ILIKE → LIKE: SQLite's LIKE is case-insensitive for ASCII by
    // default (case_sensitive_like pragma defaults to off), so plain
    // LIKE matches the Postgres ILIKE semantics for the latin scripts
    // the codebase searches over.
    .replace(/\bILIKE\b/gi, "LIKE")
    // Postgres `col->>'field'` → SQLite `json_extract(col, '$.field')`.
    // Handles bare column names and table-qualified ones (m.content->>'x').
    .replace(
      /([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)->>'([^']+)'/g,
      "json_extract($1, '$.$2')",
    )
    // ::text / ::int cast suffixes — drop, SQLite is dynamically typed.
    .replace(/::\w+/g, "")
    // NULLS LAST — SQLite supports it from 3.30+, but the portable
    // equivalent costs nothing and protects older builds.
    .replace(
      /ORDER BY\s+([^\s,]+)\s+NULLS\s+LAST/gi,
      "ORDER BY $1 IS NULL, $1",
    );

  // If the original query used no $N placeholders, the caller's params
  // array is already in textual order — pass it through. Otherwise the
  // remapped list (built in $N occurrence order) is authoritative.
  return {
    sql: finalSql,
    params: /\$\d+/.test(sql) ? remapped : params,
  };
}

function bindParam(p: unknown): unknown {
  if (typeof p === "boolean") return p ? 1 : 0;
  if (p instanceof Date) return p.toISOString();
  if (p === undefined) return null;
  return p;
}

interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

function execQuery<T>(
  db: BetterSqlite3Db,
  sql: string,
  params: unknown[] = [],
): QueryResult<T> {
  const { sql: translated, params: orderedParams } =
    translateSqlAndParams(sql, params);
  const bound = orderedParams.map(bindParam);
  const stmt = db.prepare(translated);
  const isReturning = /\bRETURNING\b/i.test(translated);
  const isSelect = /^\s*(WITH\b[\s\S]*?\bSELECT\b|SELECT\b)/i.test(translated);
  if (isSelect || isReturning) {
    const rows = stmt.all(...bound) as T[];
    return { rows, rowCount: rows.length };
  }
  const info = stmt.run(...bound);
  return { rows: [] as T[], rowCount: info.changes };
}

/**
 * SQLite-backed pool, shaped to keep the existing pg-style query layer
 * compiling. better-sqlite3 is synchronous; `query` wraps the result in
 * a resolved Promise so callers can keep their `await` syntax.
 *
 * # Transaction model
 *
 * Transactions are SYNCHRONOUS. Use `transact(pool, fn)`; the callback
 * must not `await`. better-sqlite3 cannot guarantee atomicity across
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
  private readonly db: BetterSqlite3Db;

  constructor(config?: PoolConfig) {
    // Resolution order: explicit `path` → explicit `connectionString`
    // (test compat shim) → `DESK_DB_PATH` env (production default, set
    // by install.sh) → `:memory:`. Both explicit forms beat env so
    // tests that pass a connection string get the per-string temp file
    // they expect even when CI sets DESK_DB_PATH.
    const path =
      config?.path
      ?? (config?.connectionString
        ? connectionStringToPath(config.connectionString)
        : undefined)
      ?? process.env.DESK_DB_PATH
      ?? ":memory:";
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("temp_store = MEMORY");
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

  /** Sync query — for use INSIDE a `transact` callback. Same translation
   * and parameter-binding pipeline as `query`, just without the Promise. */
  querySync<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): QueryResult<T> {
    return execQuery<T>(this.db, sql, params);
  }

  /**
   * pg.Pool compat: returns a "client". With SQLite there's no real
   * pooling, so the same Pool object is its own client. New code
   * should call `query` / `querySync` directly; this is here for any
   * remaining pg-shaped call sites.
   */
  async connect(): Promise<PoolClient> {
    return this as unknown as PoolClient;
  }

  release(): void {
    /* no-op */
  }

  on(_event: string, _fn: (...args: unknown[]) => void): this {
    return this;
  }

  async end(): Promise<void> {
    this.db.close();
  }

  /** Multi-statement script execution. Bypasses translateSql. */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  raw(): BetterSqlite3Db {
    return this.db;
  }
}

/**
 * Maps a Postgres-style connection string to a deterministic temp-file
 * path so two `new Pool({ connectionString })` calls with the same string
 * see the same database. This preserves the "shared persistence" intent
 * of tests like auth.test.ts's "fresh pool against the same database",
 * which relied on Postgres-server-side sharing.
 *
 * Per-process-unique paths ensure parallel test workers don't collide.
 */
function connectionStringToPath(connStr: string): string {
  // Plain `:memory:` is a non-persistent SQLite sentinel — pass through.
  if (connStr === ":memory:") return ":memory:";
  const hash = createHash("sha256")
    .update(`${process.pid}:${connStr}`)
    .digest("hex")
    .slice(0, 16);
  return join(tmpdir(), `desk-test-${hash}.db`);
}

/**
 * pg compat: `Queryable = pg.Pool | pg.PoolClient` is a common alias in
 * query files; both resolve to the same Pool object here.
 */
export type PoolClient = Pool;

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
 * propagates. better-sqlite3's `db.transaction` handles the BEGIN /
 * COMMIT / ROLLBACK plumbing and supports nested calls via savepoints.
 */
export function transact<T>(pool: Pool, fn: (db: Pool) => Sync<T>): T {
  const wrapped = pool.raw().transaction(() => fn(pool));
  try {
    return wrapped.immediate() as T;
  } catch (err) {
    // better-sqlite3 throws "Transaction function cannot return a promise"
    // when the callback returned a thenable. Re-throw with an actionable
    // message pointing at the file header so the fix path is obvious.
    if (err instanceof Error && /promise/i.test(err.message)) {
      throw new Error(
        "transact() callback must be synchronous — never `await` inside. " +
          "Move async work outside the transaction or use compare-and-swap. " +
          "See pool.ts header for the pattern.",
        { cause: err },
      );
    }
    throw err;
  }
}
