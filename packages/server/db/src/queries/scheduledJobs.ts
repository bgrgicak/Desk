import pg from "pg";
import { ScheduledJobSchema, type ScheduledJob } from "@desk/shared";

type Queryable = pg.Pool | pg.PoolClient;

function rowToScheduledJob(row: Record<string, unknown>): ScheduledJob {
  return ScheduledJobSchema.parse({
    id: row.id,
    chatId: row.chat_id ?? undefined,
    kind: row.kind,
    spec: row.spec,
    atJobId: row.at_job_id ?? undefined,
    crontabId: row.crontab_id ?? undefined,
    nextRunAt: row.next_run_at ? (row.next_run_at as Date).toISOString() : undefined,
    active: row.active,
  });
}

export async function insert(
  db: Queryable,
  data: {
    id: string;
    chatId?: string;
    kind: string;
    spec: unknown;
    atJobId?: string;
    crontabId?: string;
    nextRunAt?: Date;
  },
): Promise<ScheduledJob> {
  const { rows } = await db.query(
    `INSERT INTO scheduled_jobs (id, chat_id, kind, spec, at_job_id, crontab_id, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      data.id,
      data.chatId ?? null,
      data.kind,
      JSON.stringify(data.spec),
      data.atJobId ?? null,
      data.crontabId ?? null,
      data.nextRunAt ?? null,
    ],
  );
  return rowToScheduledJob(rows[0]);
}

export async function findById(db: Queryable, id: string): Promise<ScheduledJob | null> {
  const { rows } = await db.query("SELECT * FROM scheduled_jobs WHERE id = $1", [id]);
  return rows.length ? rowToScheduledJob(rows[0]) : null;
}

export async function listActive(db: Queryable): Promise<ScheduledJob[]> {
  const { rows } = await db.query(
    "SELECT * FROM scheduled_jobs WHERE active = true ORDER BY next_run_at NULLS LAST",
  );
  return rows.map(rowToScheduledJob);
}

export async function update(
  db: Queryable,
  id: string,
  data: { atJobId?: string; crontabId?: string; nextRunAt?: Date; active?: boolean },
): Promise<ScheduledJob | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (data.atJobId !== undefined) {
    sets.push(`at_job_id = $${idx++}`);
    params.push(data.atJobId);
  }
  if (data.crontabId !== undefined) {
    sets.push(`crontab_id = $${idx++}`);
    params.push(data.crontabId);
  }
  if (data.nextRunAt !== undefined) {
    sets.push(`next_run_at = $${idx++}`);
    params.push(data.nextRunAt);
  }
  if (data.active !== undefined) {
    sets.push(`active = $${idx++}`);
    params.push(data.active);
  }
  if (sets.length === 0) return findById(db, id);

  params.push(id);
  const { rows } = await db.query(
    `UPDATE scheduled_jobs SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return rows.length ? rowToScheduledJob(rows[0]) : null;
}

export async function cancel(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE scheduled_jobs SET active = false WHERE id = $1",
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export async function listForReconcile(db: Queryable): Promise<ScheduledJob[]> {
  const { rows } = await db.query(
    `SELECT * FROM scheduled_jobs
     WHERE active = true AND (at_job_id IS NOT NULL OR crontab_id IS NOT NULL)
     ORDER BY id`,
  );
  return rows.map(rowToScheduledJob);
}
