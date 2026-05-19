import {
  ConflictError,
  UnauthorizedError,
  ValidationError,
} from "@agent-desk/shared";
import {
  type SecretEntry,
  type SecretSummary,
  type VaultStore,
  VaultPasswordError,
} from "../vault/store.js";
import { enforcePasswordPolicy } from "../auth/passwordPolicy.js";

/**
 * Vault-and-secrets HTTP handlers. All vault state lives in the in-process
 * VaultStore — see vault/store.ts. These functions deliberately don't
 * touch SQLite: secrets are stored only in the per-user KDBX file.
 */

export async function getStatus(
  vault: VaultStore,
  userId: string,
): Promise<{ exists: boolean; locked: boolean }> {
  return vault.status(userId);
}

export async function setup(
  vault: VaultStore,
  userId: string,
  body: { password?: unknown },
): Promise<{ ok: true }> {
  const password = requirePassword(body);
  enforceVaultPasswordPolicy(password);
  const status = await vault.status(userId);
  if (status.exists) {
    throw new ConflictError("Vault already exists");
  }
  await vault.setup(userId, password);
  return { ok: true };
}

export async function unlock(
  vault: VaultStore,
  userId: string,
  body: { password?: unknown },
): Promise<{ ok: true }> {
  const password = requirePassword(body);
  try {
    await vault.unlock(userId, password);
    return { ok: true };
  } catch (err) {
    if (err instanceof VaultPasswordError) {
      throw new UnauthorizedError("Wrong vault password");
    }
    throw err;
  }
}

export function lock(vault: VaultStore, userId: string): { ok: true } {
  vault.lock(userId);
  return { ok: true };
}

export function listSecrets(
  vault: VaultStore,
  userId: string,
): { secrets: SecretSummary[] } {
  return { secrets: vault.list(userId) };
}

export async function createSecret(
  vault: VaultStore,
  userId: string,
  body: unknown,
): Promise<SecretSummary> {
  const secret = parseSecret(body);
  await vault.upsert(userId, secret);
  // Return the metadata so the client can stitch into its list cache.
  const created = vault.list(userId).find((s) => s.title === secret.title);
  if (!created) throw new Error(`Failed to persist secret '${secret.title}'`);
  return created;;
}

export async function updateSecret(
  vault: VaultStore,
  userId: string,
  title: string,
  body: unknown,
): Promise<SecretSummary> {
  const secret = parseSecret(body);
  if (secret.title !== title) {
    // For v1, PUT carries the title in both URL and body and they must
    // match. Renaming would need a separate, deliberate flow.
    throw new ValidationError("Body title must match URL title");
  }
  // Verify the entry exists; PUT is for overwriting, not for creating.
  const existing = vault.get(userId, title);
  if (!existing) {
    throw new ConflictError(`No secret with title '${title}'`);
  }
  await vault.upsert(userId, secret);
  const updated = vault.list(userId).find((s) => s.title === title);
  if (!updated) throw new Error(`Failed to persist secret '${title}'`);
  return updated;;
}

// ── Sandbox-side handlers ────────────────────────────────────────────────

export function sandboxList(
  vault: VaultStore,
  userId: string,
): { secrets: SecretSummary[] } {
  return { secrets: vault.list(userId) };
}

export function sandboxGet(
  vault: VaultStore,
  userId: string,
  title: string,
): SecretEntry | null {
  return vault.get(userId, title);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function requirePassword(body: { password?: unknown }): string {
  if (!body || typeof body.password !== "string" || body.password.length === 0) {
    throw new ValidationError("Missing password");
  }
  return body.password;
}

// Policy for *new* vault passwords only (POST /vault/setup).  Shared
// with /me/password and /auth/signup via passwordPolicy.ts — see
// the helper there for the threat model.  We can't enforce it on
// /vault/unlock without locking out users whose vault predates the
// policy.
export function enforceVaultPasswordPolicy(password: string): void {
  enforcePasswordPolicy(password);
}

function parseSecret(body: unknown): SecretEntry {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Body must be an object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.title !== "string" || b.title.length === 0) {
    throw new ValidationError("Missing title");
  }
  if (typeof b.password !== "string" || b.password.length === 0) {
    throw new ValidationError("Missing password");
  }
  const out: SecretEntry = { title: b.title, password: b.password };
  if (typeof b.username === "string" && b.username.length > 0) out.username = b.username;
  if (typeof b.url === "string" && b.url.length > 0) out.url = b.url;
  if (typeof b.notes === "string" && b.notes.length > 0) out.notes = b.notes;
  if (b.fields && typeof b.fields === "object") {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.fields)) {
      if (typeof v === "string") fields[k] = v;
    }
    if (Object.keys(fields).length > 0) out.fields = fields;
  }
  return out;
}
