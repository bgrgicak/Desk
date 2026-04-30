import { type Pool } from "../pool.js";
import { encryptJson, decryptJson } from "../encryption.js";

/**
 * Reads a user's provider keys. Returns an empty object if no row exists
 * or the stored payload is empty.
 */
export async function getProviderKeys(
  db: Pool,
  userId: string,
): Promise<Record<string, string>> {
  const { rows } = await db.query(
    "SELECT provider_keys_encrypted FROM user_settings WHERE user_id = ?",
    [userId],
  );
  if (rows.length === 0) return {};
  const ciphertext = rows[0].provider_keys_encrypted as Buffer | null;
  if (!ciphertext || ciphertext.length === 0) return {};
  return decryptJson<Record<string, string>>(ciphertext);
}

/**
 * Replaces a user's provider keys with the given map (full overwrite).
 * Upserts the user_settings row.
 */
export async function setProviderKeys(
  db: Pool,
  userId: string,
  keys: Record<string, string>,
): Promise<void> {
  const payload = encryptJson(keys);
  await db.query(
    `INSERT INTO user_settings (user_id, provider_keys_encrypted, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (user_id) DO UPDATE
       SET provider_keys_encrypted = EXCLUDED.provider_keys_encrypted,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    [userId, payload],
  );
}

/**
 * Merges the given map into the user's stored provider keys. A null value
 * deletes that key; any other value replaces it. Keys not mentioned are
 * preserved.
 */
export async function mergeProviderKeys(
  db: Pool,
  userId: string,
  patch: Record<string, string | null>,
): Promise<Record<string, string>> {
  const current = await getProviderKeys(db, userId);
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) {
      delete current[name];
    } else {
      current[name] = value;
    }
  }
  await setProviderKeys(db, userId, current);
  return current;
}

// ── Provider metadata (display names, etc.) ──────────────────────────────────

export type ProviderMetaEntry = { name?: string };
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
    "SELECT provider_meta_encrypted FROM user_settings WHERE user_id = ?",
    [userId],
  );
  if (rows.length === 0) return {};
  const ciphertext = rows[0].provider_meta_encrypted as Buffer | null;
  if (!ciphertext || ciphertext.length === 0) return {};
  return decryptJson<ProviderMetaMap>(ciphertext);
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
      current[key] = { ...current[key], ...entry };
    }
  }
  const payload = encryptJson(current);
  await db.query(
    `INSERT INTO user_settings (user_id, provider_meta_encrypted, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (user_id) DO UPDATE
       SET provider_meta_encrypted = EXCLUDED.provider_meta_encrypted,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    [userId, payload],
  );
  return current;
}
