import pg from "pg";
import { generateId, PROVIDER_KEY_VARS, TOOLS, type ToolName } from "@desk/shared";
import { hashPassword } from "./passwords.js";
import * as userSettings from "./queries/userSettings.js";

export async function seedIfEmpty(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query("SELECT count(*)::int AS c FROM users");
  if (rows[0].c > 0) return;

  const username = process.env.DESK_SEED_USERNAME ?? "desk";
  const password = process.env.DESK_SEED_PASSWORD ?? "change-me-before-first-boot";

  const userId = generateId("user");
  const agentId = generateId("agent");
  const workspaceId = generateId("workspace");

  const toolNames = Object.keys(TOOLS) as ToolName[];
  const passwordHash = await hashPassword(password);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO users (id, username, password_hash, email)
       VALUES ($1, $2, $3, $4)`,
      [userId, username, passwordHash, `${username}@desk.local`],
    );

    await client.query(
      `INSERT INTO agents (id, name, instructions, model, tool_allowlist)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        agentId,
        "Desk",
        "You are Desk, a helpful AI assistant.",
        "anthropic/claude-sonnet-4-20250514",
        JSON.stringify(toolNames),
      ],
    );

    await client.query(
      `INSERT INTO workspaces (id, user_id, name)
       VALUES ($1, $2, $3)`,
      [workspaceId, userId, "Desk"],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Dev-only: for every user with no stored provider keys, scan the host env for
 * known provider vars and populate user_settings with what's set.
 *
 * Gated by DESK_DEV=1 so prod can never leak host env into the DB.
 */
export async function seedProviderKeysFromEnv(pool: pg.Pool): Promise<void> {
  if (process.env.DESK_DEV !== "1") return;

  const envKeys: Record<string, string> = {};
  for (const name of PROVIDER_KEY_VARS) {
    const v = process.env[name];
    if (v && v.length > 0) envKeys[name] = v;
  }
  if (Object.keys(envKeys).length === 0) return;

  const { rows } = await pool.query("SELECT id FROM users");
  for (const row of rows) {
    const userId = row.id as string;
    const existing = await userSettings.getProviderKeys(pool, userId);
    if (Object.keys(existing).length > 0) continue;
    await userSettings.setProviderKeys(pool, userId, envKeys);
  }
}
