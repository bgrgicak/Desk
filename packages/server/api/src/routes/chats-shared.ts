import { type Pool } from "@roomy-ai/db";
import { NotFoundError } from "@roomy-ai/shared";

/**
 * Resolves the on-disk slug for a chat's workspace. Used by route handlers
 * that need to build a filesystem path from a bare chatId. Throws if the
 * chat is missing.
 *
 * Lives in its own module so the two siblings — chats.ts and
 * chats-attachments.ts — can share it without forming an import cycle.
 */
export async function workspaceSlugForChat(pool: Pool, chatId: string): Promise<string> {
  const { rows } = await pool.query<{ path: string }>(
    `SELECT w.path FROM chats c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?`,
    [chatId],
  );
  if (rows.length === 0) throw new NotFoundError(`Chat not found: ${chatId}`);
  return rows[0].path;
}
