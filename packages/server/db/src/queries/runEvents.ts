import pg from "pg";
import { RunEventSchema, type RunEvent } from "@desk/shared";

type Queryable = pg.Pool | pg.PoolClient;

function rowToRunEvent(row: Record<string, unknown>): RunEvent {
  return RunEventSchema.parse({
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    kind: row.kind,
    payload: row.payload,
    createdAt: (row.created_at as Date).toISOString(),
  });
}

export async function append(
  db: Queryable,
  data: { id: string; runId: string; seq: number; kind: string; payload?: Record<string, unknown> },
): Promise<RunEvent> {
  const { rows } = await db.query(
    `INSERT INTO run_events (id, run_id, seq, kind, payload)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [data.id, data.runId, data.seq, data.kind, JSON.stringify(data.payload ?? {})],
  );
  return rowToRunEvent(rows[0]);
}

export interface PaginatedRunEvents {
  items: RunEvent[];
  nextCursor?: number;
}

export async function listByRun(
  db: Queryable,
  runId: string,
  opts?: { cursor?: number; limit?: number },
): Promise<PaginatedRunEvents> {
  const limit = opts?.limit ?? 100;
  const params: unknown[] = [runId, limit + 1];
  let whereClause = "run_id = $1";

  if (opts?.cursor !== undefined) {
    whereClause += " AND seq > $3";
    params.push(opts.cursor);
  }

  const { rows } = await db.query(
    `SELECT * FROM run_events WHERE ${whereClause} ORDER BY seq LIMIT $2`,
    params,
  );

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(rowToRunEvent);
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1].seq : undefined,
  };
}
