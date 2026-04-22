import pg from "pg";
import { encryptJson, decryptJson } from "../encryption.js";

type Queryable = pg.Pool | pg.PoolClient;

/**
 * Reads a user's provider keys. Returns an empty object if no row exists
 * or the stored payload is empty.
 */
export async function getProviderKeys(
  db: Queryable,
  userId: string,
): Promise<Record<string, string>> {
  const { rows } = await db.query(
    "SELECT provider_keys_encrypted FROM user_settings WHERE user_id = $1",
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
  db: Queryable,
  userId: string,
  keys: Record<string, string>,
): Promise<void> {
  const payload = encryptJson(keys);
  await db.query(
    `INSERT INTO user_settings (user_id, provider_keys_encrypted, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE
       SET provider_keys_encrypted = EXCLUDED.provider_keys_encrypted,
           updated_at = now()`,
    [userId, payload],
  );
}

/**
 * Merges the given map into the user's stored provider keys. A null value
 * deletes that key; any other value replaces it. Keys not mentioned are
 * preserved.
 */
export async function mergeProviderKeys(
  db: Queryable,
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
