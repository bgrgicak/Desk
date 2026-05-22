import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Resolves the operator-supplied vault master password (DESK_VAULT_PASSWORD)
 * from process.env or from `${DESK_HOME}/.env`. Returns `null` when neither
 * source has one — in that case boot-time auto-unlock is skipped and users
 * pick their own password through the VaultDialog the first time they
 * store a credential.
 *
 * Note: this function does NOT generate or persist a fresh password. The
 * old "auto-generate on first boot" behaviour stored the master in
 * plaintext .env, which defeats the purpose of the encrypted vault — opt
 * in explicitly when you need it (E2E, CI, single-user dev).
 */
export async function resolveVaultPasswordEnv(opts: {
  deskHome: string;
  env?: NodeJS.ProcessEnv;
  envFile?: string;
}): Promise<string | null> {
  const env = opts.env ?? process.env;
  if (env.DESK_VAULT_PASSWORD) return env.DESK_VAULT_PASSWORD;

  const envFile = opts.envFile ?? env.DESK_ENV_FILE ?? path.join(opts.deskHome, ".env");
  try {
    const existing = await fs.readFile(envFile, "utf-8");
    const value = readEnvValue(existing, "DESK_VAULT_PASSWORD");
    if (value) {
      env.DESK_VAULT_PASSWORD = value;
      return value;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return null;
}

function readEnvValue(body: string, key: string): string | null {
  const pattern = new RegExp(`^${key}=(.*)$`, "m");
  const match = body.match(pattern);
  if (!match) return null;
  const raw = match[1]?.trim() ?? "";
  const unquoted = raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  return unquoted || null;
}
