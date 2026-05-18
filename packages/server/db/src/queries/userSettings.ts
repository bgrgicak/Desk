import { type Pool } from "../pool.js";

// ── Provider metadata (display names, enabled/disabled) ──────────────────────

export type ProviderMetaEntry = {
  name?: string;
  /**
   * Tracks whether the user has opted in and any custom display name.
   */
  enabled?: boolean;
};
export type ProviderMetaMap  = Record<string, ProviderMetaEntry>;

/**
 * Reads per-provider metadata for the user. Returns an empty object when
 * no row exists or the column is null.
 */
export async function getProviderMeta(
  db: Pool,
  userId: string,
): Promise<ProviderMetaMap> {
  const { rows } = await db.query(
    "SELECT provider_meta_json FROM user_settings WHERE user_id = ?",
    [userId],
  );
  if (rows.length === 0) return {};
  const raw = rows[0].provider_meta_json as string | null;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as ProviderMetaMap;
  } catch {
    return {};
  }
}

/**
 * Merges the given metadata patch into the user's stored provider meta.
 * Each entry is merged at the key level (not deep-merged within entries).
 * A null entry removes that provider's metadata entirely.
 */
export async function mergeProviderMeta(
  db: Pool,
  userId: string,
  patch: Record<string, ProviderMetaEntry | null>,
): Promise<ProviderMetaMap> {
  const current = await getProviderMeta(db, userId);
  for (const [key, entry] of Object.entries(patch)) {
    if (entry === null) {
      delete current[key];
    } else {
      const next = { ...current[key], ...entry };
      for (const [field, value] of Object.entries(entry)) {
        if (value === undefined) delete next[field as keyof ProviderMetaEntry];
      }
      current[key] = next;
    }
  }
  const payload = JSON.stringify(current);
  await db.query(
    `INSERT INTO user_settings (user_id, provider_meta_json, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (user_id) DO UPDATE
       SET provider_meta_json = EXCLUDED.provider_meta_json,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    [userId, payload],
  );
  return current;
}
