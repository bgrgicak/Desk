import { type Pool } from "../pool.js";

type Queryable = Pool;

export async function pin(
  db: Queryable,
  workspaceId: string,
  chatId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO chat_pins (workspace_id, chat_id)
     VALUES (?, ?)
     ON CONFLICT DO NOTHING`,
    [workspaceId, chatId],
  );
}

export async function unpin(
  db: Queryable,
  workspaceId: string,
  chatId: string,
): Promise<void> {
  await db.query(
    `DELETE FROM chat_pins WHERE workspace_id = ? AND chat_id = ?`,
    [workspaceId, chatId],
  );
}

export async function listPinnedChatIds(
  db: Queryable,
  workspaceId: string,
): Promise<Set<string>> {
  const { rows } = await db.query<{ chat_id: string }>(
    `SELECT chat_id FROM chat_pins WHERE workspace_id = ?`,
    [workspaceId],
  );
  return new Set(rows.map((r) => r.chat_id));
}
