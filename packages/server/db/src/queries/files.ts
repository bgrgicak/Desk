import pg from "pg";
import { FileSchema, type File } from "@desk/shared";

type Queryable = pg.Pool | pg.PoolClient;

function rowToFile(row: Record<string, unknown>): File {
  return FileSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    chatId: row.chat_id ?? undefined,
    class: row.class,
    path: row.path,
    name: row.name,
    mime: row.mime,
    size: row.size,
    createdAt: (row.created_at as Date).toISOString(),
  });
}

export async function insert(
  db: Queryable,
  data: {
    id: string;
    workspaceId: string;
    chatId?: string;
    class: string;
    path: string;
    name: string;
    mime: string;
    size: number;
  },
): Promise<File> {
  const { rows } = await db.query(
    `INSERT INTO files (id, workspace_id, chat_id, class, path, name, mime, size)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [data.id, data.workspaceId, data.chatId ?? null, data.class, data.path, data.name, data.mime, data.size],
  );
  return rowToFile(rows[0]);
}

export async function findById(db: Queryable, id: string): Promise<File | null> {
  const { rows } = await db.query("SELECT * FROM files WHERE id = $1", [id]);
  return rows.length ? rowToFile(rows[0]) : null;
}

export async function listByWorkspace(
  db: Queryable,
  workspaceId: string,
  opts?: { class?: string; cursor?: string; limit?: number },
): Promise<{ items: File[]; nextCursor?: string }> {
  const limit = opts?.limit ?? 50;
  const params: unknown[] = [workspaceId, limit + 1];
  let whereClause = "workspace_id = $1";
  let idx = 3;

  if (opts?.class) {
    whereClause += ` AND class = $${idx++}`;
    params.push(opts.class);
  }
  if (opts?.cursor) {
    whereClause += ` AND created_at < $${idx++}`;
    params.push(new Date(opts.cursor));
  }

  const { rows } = await db.query(
    `SELECT * FROM files WHERE ${whereClause} ORDER BY created_at DESC LIMIT $2`,
    params,
  );

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(rowToFile);
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1].createdAt : undefined,
  };
}

export async function listByChat(
  db: Queryable,
  chatId: string,
): Promise<File[]> {
  const { rows } = await db.query(
    "SELECT * FROM files WHERE chat_id = $1 ORDER BY created_at DESC",
    [chatId],
  );
  return rows.map(rowToFile);
}

export async function deleteById(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM files WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}
