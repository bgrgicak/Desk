import { type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import { CONNECTION_ENV_VARS } from "@agent-desk/shared";
import type { VaultStore } from "./vault/store.js";

/**
 * Resolves the provider API keys that should populate the sandbox env.
 * Keys are stored in the per-user KDBX vault; returns an empty object if
 * the vault is locked or not set up.
 *
 * Disabled providers (per Settings → Connections toggle) are filtered out
 * so they neither show up in the model picker nor get forwarded to the sandbox.
 */
export async function resolveProviderKeys(
  pool: Pool,
  vault: VaultStore | undefined,
  userId?: string,
): Promise<Record<string, string>> {
  if (!vault) return {};

  let resolvedUserId = userId;
  if (!resolvedUserId) {
    const { rows } = await pool.query(
      "SELECT id FROM users ORDER BY created_at LIMIT 1",
    );
    if (rows.length === 0) return {};
    resolvedUserId = rows[0].id as string;
  }

  if (vault.isLocked(resolvedUserId)) return {};

  const meta = await queries.userSettings.getProviderMeta(pool, resolvedUserId);
  const out: Record<string, string> = {};
  for (const name of CONNECTION_ENV_VARS) {
    if (meta[name]?.enabled === false) continue;
    const secret = vault.get(resolvedUserId, name);
    if (secret?.password) out[name] = secret.password;
  }
  return out;
}
