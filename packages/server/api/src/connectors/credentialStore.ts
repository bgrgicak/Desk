import { VaultLockedError } from "@roomy-ai/shared";
import type { VaultStore } from "../vault/store.js";

/**
 * Single API for reading and writing connector-connection credentials.
 *
 * One physical store: the per-user KDBX vault. Each connection has exactly
 * one entry, titled `connector:<userId>:<providerId>:<connectionId>`. The
 * password field carries a JSON credential bag whose shape depends on the
 * provider (e.g. `{ token }` for static API keys, `{ refresh_token,
 * client_id, client_secret, ... }` for OAuth).
 *
 * Vault locked is a hard error on write — callers must surface it. On read
 * we return null so the resolver can fail closed without throwing through
 * unrelated code paths.
 */

export type CredentialBag = Record<string, unknown>;

export function credentialTitle(userId: string, providerId: string, connectionId: string): string {
  return `connector:${userId}:${providerId}:${connectionId}`;
}

export function readCredentials(
  vault: VaultStore,
  userId: string,
  providerId: string,
  connectionId: string,
): CredentialBag | null {
  if (vault.isLocked(userId)) return null;
  const entry = vault.get(userId, credentialTitle(userId, providerId, connectionId));
  if (!entry) return null;
  try {
    const parsed = JSON.parse(entry.password) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as CredentialBag;
  } catch {
    return null;
  }
}

export async function writeCredentials(
  vault: VaultStore,
  userId: string,
  connection: {
    id: string;
    providerId: string;
    displayName: string;
    externalAccountId?: string;
  },
  credentials: CredentialBag,
): Promise<void> {
  if (vault.isLocked(userId)) {
    throw new VaultLockedError("Secrets vault must be unlocked to store connector credentials");
  }
  await vault.upsert(userId, {
    title: credentialTitle(userId, connection.providerId, connection.id),
    username: connection.externalAccountId,
    password: JSON.stringify(credentials),
    notes: `Credentials for ${connection.displayName}`,
    fields: { providerId: connection.providerId, connectionId: connection.id },
  });
}

/**
 * Idempotent: silently no-ops when the vault is locked or the entry is
 * absent. Used at connection-delete time, where a missing vault entry is
 * not an error condition.
 */
export async function deleteCredentials(
  vault: VaultStore,
  userId: string,
  providerId: string,
  connectionId: string,
): Promise<void> {
  if (vault.isLocked(userId)) return;
  try {
    await vault.delete(userId, credentialTitle(userId, providerId, connectionId));
  } catch (err) {
    if (err instanceof VaultLockedError) return;
    throw err;
  }
}

export function hasCredentials(
  vault: VaultStore,
  userId: string,
  providerId: string,
  connectionId: string,
): boolean {
  if (vault.isLocked(userId)) return false;
  return Boolean(vault.get(userId, credentialTitle(userId, providerId, connectionId)));
}
