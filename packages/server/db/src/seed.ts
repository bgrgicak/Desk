import pg from "pg";
import { generateId, PROVIDER_KEY_VARS } from "@desk/shared";
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
      `INSERT INTO agents (id, user_id, name, instructions, model)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        agentId,
        userId,
        "Desk",
        "You are Desk, a helpful AI assistant.",
        "opencode/big-pickle",
      ],
    );

    await client.query(
      `INSERT INTO workspaces (id, user_id, name, path)
       VALUES ($1, $2, $3, $4)`,
      [workspaceId, userId, "Desk", "desk"],
    );

    await client.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id)
       VALUES ($1, $2)`,
      [workspaceId, agentId],
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
