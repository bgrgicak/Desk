# ADR-0006: SQLite is single-node by design; the post-SQLite story

**Status**: Accepted (2026-05-18)

## Context

Desk uses SQLite with WAL mode + `locking_mode=EXCLUSIVE` (see
`packages/server/db/src/pool.ts`). The exclusive lock means
exactly one process can hold the database open; a second
desk-server boot against the same file fails fast on
`SQLITE_BUSY`. This is intentional — the architecture is
single-node and the lock surfaces accidental misconfiguration.

The PR audit asked "what happens if we outgrow this?" — a
fair question for a product that's about to go to private beta.
Three growth dimensions:

1. **Write throughput**: a single user generating > 10 chat
   turns/sec for sustained periods.
2. **Storage size**: > 100 GB of file + chat data.
3. **Multi-user concurrent**: > 50 simultaneous active users on
   one host.

## Decision

Stay on SQLite. The growth dimensions above are not
realistically hit by the private-beta workload (one user at a
time, mostly idle, < 1 GB / month). When they do start to bite,
the migration path is to Postgres, not to a different SQLite
deployment shape.

The path:
1. The DB layer is already abstracted behind `Pool` — every
   query goes through `pool.query` (async) or `pool.querySync`
   (inside `transact`). SQLite-specific syntax appears in
   migrations and the pool init.
2. Migrations live in `packages/server/db/migrations/` as plain
   SQL. The Postgres dialect is close enough that 80% of files
   port without changes; the exceptions are JSON columns
   (`json_extract` → `->`) and the `RETURNING *` shapes (already
   compatible).
3. The connection-pooling story changes: SQLite's single-writer
   model needs no pool; Postgres needs `pg-pool` or similar. The
   `Pool` class swaps out, the call sites don't.
4. FTS — the chat-search FTS5 setup (migration 0028) has no
   Postgres equivalent; switch to `tsvector` + `tsquery` at
   port time.

The architecture decision recorded here is **not** "move to
Postgres now" — it's "we know how, when the time comes."

## Consequences

- The single-node assumption shows up in: the in-memory rate
  limiter (process restart wipes it), the in-memory vault
  master cache (same), the in-memory session token cache, and
  the WS connection registry. Each is correctly local to the
  process and would need a Redis-shaped cross-process store at
  multi-node time.
- `locking_mode=EXCLUSIVE` is a forcing function: a second
  desk-server boot against the same DB file fails fast. This
  makes "accidentally run two copies" loud, which is what we
  want for a single-node product.

## Alternatives considered

LiteFS-style SQLite replication was looked at — it gets you
read replicas + auto-failover but keeps the SQLite write-once
semantics. Useful for read-heavy workloads; the agent-write
workload doesn't fit.

DuckDB was rejected — column-store with no concurrent writers,
opposite of our shape.

A custom-built replication layer was rejected on operational
complexity grounds.

## Reversal cost

The two paths back from a Postgres migration are: (a) keep the
Pool abstraction, change just the engine — same code shape; or
(b) accept that SQLite was the right call all along and revert
the migration. Both depend on the Pool abstraction staying tight.
