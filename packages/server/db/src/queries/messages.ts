import pg from "pg";
import { MessageSchema, type Message } from "@desk/shared";

type Queryable = pg.Pool | pg.PoolClient;

function rowToMessage(row: Record<string, unknown>): Message {
  return MessageSchema.parse({
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    content: row.content,
    createdAt: (row.created_at as Date).toISOString(),
  });
}

export interface PaginatedMessages {
  items: Message[];
  nextCursor?: string;
}

export async function listByChat(
  db: Queryable,
  chatId: string,
  opts?: { cursor?: string; limit?: number },
): Promise<PaginatedMessages> {
  const limit = opts?.limit ?? 50;
  const params: unknown[] = [chatId, limit + 1];
  let whereClause = "chat_id = $1";

  if (opts?.cursor) {
    whereClause += " AND created_at > $3";
    params.push(new Date(opts.cursor));
  }

  const { rows } = await db.query(
    `SELECT * FROM messages WHERE ${whereClause} ORDER BY created_at LIMIT $2`,
    params,
  );

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(rowToMessage);
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1].createdAt : undefined,
  };
}

export async function insert(
  db: Queryable,
  data: { id: string; chatId: string; role: string; content: unknown },
): Promise<Message> {
  const { rows } = await db.query(
    `INSERT INTO messages (id, chat_id, role, content)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.id, data.chatId, data.role, JSON.stringify(data.content)],
  );
  // Touch the parent chat's updated_at
  await db.query("UPDATE chats SET updated_at = now(), unread = true WHERE id = $1", [data.chatId]);
  return rowToMessage(rows[0]);
}
