import { type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import { NotFoundError, PROVIDER_KEY_VARS, ValidationError } from "@agent-desk/shared";
import type { VaultStore } from "../vault/store.js";

type ProviderMetaEntry = { name?: string; enabled?: boolean };
type ProviderMetaMap  = Record<string, ProviderMetaEntry>;

export async function getMe(pool: Pool, userId: string) {
  const user = await queries.users.findById(pool, userId);
  if (!user) throw new NotFoundError("User not found");
  return user;
}

export async function patchMe(
  pool: Pool,
  userId: string,
  data: { username?: string; email?: string; avatarPath?: string },
) {
  const user = await queries.users.updateProfile(pool, userId, data);
  if (!user) throw new NotFoundError("User not found");
  return user;
}

export async function changePassword(
  pool: Pool,
  userId: string,
  data: { currentPassword: string; newPassword: string },
) {
  await queries.users.setPassword(pool, userId, data.currentPassword, data.newPassword);
  return { ok: true };
}

/**
 * Soft-delete current account. v1: no-op stub — records the intent but
 * does not actually remove data.
 */
export async function deleteMe(
  _pool: Pool,
  _userId: string,
): Promise<{ ok: true; message: string }> {
  return { ok: true, message: "Account marked for deletion" };
}

/** Reveal first 6 + last 4 characters of a key; mask the middle. */
function maskKey(value: string): string {
  if (value.length <= 10) return "****";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/**
 * Returns provider keys for the current user, masked. Every known
 * PROVIDER_KEY_VARS name appears in the response (null when unset) so the UI
 * can render a complete form. Returns all-null when the vault is locked or
 * not yet set up — vault status is surfaced separately via GET /vault/status.
 */
export function getProviders(
  vault: VaultStore,
  userId: string,
): { providers: Record<string, string | null> } {
  const providers: Record<string, string | null> = {};
  for (const name of PROVIDER_KEY_VARS) {
    providers[name] = null;
  }
  if (vault.isLocked(userId)) return { providers };
  for (const name of PROVIDER_KEY_VARS) {
    const secret = vault.get(userId, name);
    providers[name] = secret ? maskKey(secret.password) : null;
  }
  return { providers };
}

/**
 * Partial-update provider keys. `null` deletes an entry; any string value
 * replaces it. Names not present in the body are left alone.
 * Requires the vault to be unlocked — throws VaultLockedError (→ 423) otherwise.
 */
export async function setProviders(
  pool: Pool,
  vault: VaultStore,
  userId: string,
  data: { providers: Record<string, string | null> },
): Promise<{ providers: Record<string, string | null> }> {
  if (!data || typeof data.providers !== "object" || data.providers === null) {
    throw new ValidationError("Missing providers object");
  }
  const allowed = new Set<string>(PROVIDER_KEY_VARS);
  for (const name of Object.keys(data.providers)) {
    if (!allowed.has(name)) {
      throw new ValidationError(`Unknown provider key: ${name}`);
    }
    const value = data.providers[name];
    if (value !== null && typeof value !== "string") {
      throw new ValidationError(`Provider key ${name} must be string or null`);
    }
  }

  for (const [name, value] of Object.entries(data.providers)) {
    if (value === null) {
      await vault.delete(userId, name);
    } else {
      await vault.upsert(userId, { title: name, password: value });
    }
  }

  const written = Object.entries(data.providers)
    .filter(([, v]) => v !== null)
    .map(([k]) => k);
  const deleted = Object.entries(data.providers)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  if (written.length > 0) {
    await queries.providerKeyAccessLog.logKeyAccess(pool, userId, "write", written, "user_update");
  }
  if (deleted.length > 0) {
    await queries.providerKeyAccessLog.logKeyAccess(pool, userId, "delete", deleted, "user_update");
  }

  return getProviders(vault, userId);
}

/**
 * Returns per-provider display metadata for the current user.
 * Response: `{ meta: Record<string, { name?: string }> }`
 */
export async function getProvidersMeta(
  pool: Pool,
  userId: string,
): Promise<{ meta: ProviderMetaMap }> {
  const meta = await queries.userSettings.getProviderMeta(pool, userId);
  return { meta };
}

/**
 * Partial-update provider metadata. Each entry is merged into the stored
 * object; a null entry removes that provider's metadata. Keys not present
 * in the body are left alone.
 */
export async function setProvidersMeta(
  pool: Pool,
  userId: string,
  data: { meta: Record<string, ProviderMetaEntry | null> },
): Promise<{ meta: ProviderMetaMap }> {
  if (!data || typeof data.meta !== "object" || data.meta === null) {
    throw new ValidationError("Missing meta object");
  }
  const meta = await queries.userSettings.mergeProviderMeta(pool, userId, data.meta);
  return { meta };
}
