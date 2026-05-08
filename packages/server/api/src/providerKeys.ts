import { type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";

/**
 * Resolves the provider API keys that should populate the sandbox env.
 * Disabled providers (per Settings → Connections toggle) are filtered
 * out so they neither show up in the model picker nor get forwarded to
 * the sandbox.
 *
 * v1 is single-user; if no userId is provided we fall back to the first
 * user. When milestone 3 lands, this will accept a workspaceId and
 * follow workspace → user → keys.
 */
export async function resolveProviderKeys(
  pool: Pool,
  userId?: string,
): Promise<Record<string, string>> {
  let resolvedUserId = userId;
  if (!resolvedUserId) {
    const { rows } = await pool.query(
      "SELECT id FROM users ORDER BY created_at LIMIT 1",
    );
    if (rows.length === 0) return {};
    resolvedUserId = rows[0].id as string;
  }
  return queries.userSettings.getActiveProviderKeys(pool, resolvedUserId);
}
