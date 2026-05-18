import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Ensures the server has a vault password in memory and persisted to an env
 * file. This lets fresh installs auto-create/auto-unlock the KDBX vault even
 * though there is no manual database unlock flow in the UI.
 */
export async function ensureVaultPasswordEnv(opts: {
  deskHome: string;
  env?: NodeJS.ProcessEnv;
  envFile?: string;
  log?: (message: string) => void;
}): Promise<string> {
  const env = opts.env ?? process.env;
  if (env.DESK_VAULT_PASSWORD) return env.DESK_VAULT_PASSWORD;

  const envFile = opts.envFile ?? env.DESK_ENV_FILE ?? path.join(opts.deskHome, ".env");
  let existing = "";
  try {
    existing = await fs.readFile(envFile, "utf-8");
    const value = readEnvValue(existing, "DESK_VAULT_PASSWORD");
    if (value) {
      env.DESK_VAULT_PASSWORD = value;
      return value;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const password = randomBytes(32).toString("base64");
  await fs.mkdir(path.dirname(envFile), { recursive: true });
  let body = existing;
  if (body.length > 0 && !body.endsWith("\n")) body += "\n";
  body += `DESK_VAULT_PASSWORD=${password}\n`;
  await fs.writeFile(envFile, body, { mode: 0o600 });
  await fs.chmod(envFile, 0o600);
  env.DESK_VAULT_PASSWORD = password;
  opts.log?.(`vault: generated DESK_VAULT_PASSWORD in ${envFile}`);
  return password;
}

function readEnvValue(body: string, key: string): string | null {
  const pattern = new RegExp(`^${key}=(.*)$`, "m");
  const match = body.match(pattern);
  if (!match) return null;
  const raw = match[1]?.trim() ?? "";
  const unquoted = raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  return unquoted || null;
}
