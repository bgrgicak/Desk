import pg from "pg";
import { queries } from "@desk/db";

/**
 * Resolves the provider API keys that should populate the sandbox env.
 *
 * v1 is single-user; we load the first user's stored provider keys. When
 * milestone 3 lands, this will accept a workspaceId and follow
 * workspace → user → keys.
 */
export async function resolveProviderKeys(
  pool: pg.Pool,
): Promise<Record<string, string>> {
  const { rows } = await pool.query(
    "SELECT id FROM users ORDER BY created_at LIMIT 1",
  );
  if (rows.length === 0) return {};
  const userId = rows[0].id as string;
  return queries.userSettings.getProviderKeys(pool, userId);
}
