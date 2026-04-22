import pg from "pg";
import { RunSchema, type Run } from "@desk/shared";

type Queryable = pg.Pool | pg.PoolClient;

function rowToRun(row: Record<string, unknown>): Run {
  return RunSchema.parse({
    id: row.id,
    chatId: row.chat_id ?? undefined,
    scheduledJobId: row.scheduled_job_id ?? undefined,
    kind: row.kind ?? "immediate",
    state: row.state,
    startedAt: row.started_at ? (row.started_at as Date).toISOString() : undefined,
    finishedAt: row.finished_at ? (row.finished_at as Date).toISOString() : undefined,
    exitCode: row.exit_code ?? undefined,
    logPath: row.log_path ?? undefined,
  });
}

export async function insert(
  db: Queryable,
  data: { id: string; chatId?: string; scheduledJobId?: string; kind?: string; state?: string; logPath?: string },
): Promise<Run> {
  const { rows } = await db.query(
    `INSERT INTO runs (id, chat_id, scheduled_job_id, kind, state, log_path)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [data.id, data.chatId ?? null, data.scheduledJobId ?? null, data.kind ?? "immediate", data.state ?? "pending", data.logPath ?? null],
  );
  return rowToRun(rows[0]);
}

export async function updateState(
  db: Queryable,
  id: string,
  data: { state: string; exitCode?: number; finishedAt?: Date },
): Promise<Run | null> {
  const sets = ["state = $1"];
  const params: unknown[] = [data.state];
  let idx = 2;

  if (data.state === "running") {
    sets.push(`started_at = COALESCE(started_at, now())`);
  }
  if (data.finishedAt !== undefined) {
    sets.push(`finished_at = $${idx++}`);
    params.push(data.finishedAt);
  } else if (data.state === "succeeded" || data.state === "failed" || data.state === "cancelled") {
    sets.push(`finished_at = COALESCE(finished_at, now())`);
  }
  if (data.exitCode !== undefined) {
    sets.push(`exit_code = $${idx++}`);
    params.push(data.exitCode);
  }

  params.push(id);
  const { rows } = await db.query(
    `UPDATE runs SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return rows.length ? rowToRun(rows[0]) : null;
}

export async function findById(db: Queryable, id: string): Promise<Run | null> {
  const { rows } = await db.query("SELECT * FROM runs WHERE id = $1", [id]);
  return rows.length ? rowToRun(rows[0]) : null;
}

export async function listRecent(
  db: Queryable,
  opts?: { limit?: number },
): Promise<Run[]> {
  const limit = opts?.limit ?? 50;
  const { rows } = await db.query(
    "SELECT * FROM runs ORDER BY COALESCE(started_at, now()) DESC LIMIT $1",
    [limit],
  );
  return rows.map(rowToRun);
}
