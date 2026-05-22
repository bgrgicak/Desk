import { type Pool, transact } from "./pool.js";
import { generateId } from "@roomy-ai/shared";
import { hashPassword } from "./passwords.js";

/**
 * The documented public seed password. Inserting a user with this exact
 * value flips `must_change_password = 1`, mirroring the behaviour of the
 * old `seedIfEmpty` boot path so the must-change-gate tests stay valid.
 */
export const PUBLIC_SEED_PASSWORD = "change-me-before-first-boot";

export interface SeedFixtureOptions {
  username?: string;
  password?: string;
  email?: string;
}

export interface SeedFixture {
  userId: string;
  agentId: string;
  workspaceId: string;
  username: string;
  email: string;
  password: string;
  mustChangePassword: boolean;
}

/**
 * Inserts a user + first agent + first workspace as test fixtures.
 *
 * Replaces the production `seedIfEmpty` boot path, which was removed
 * once the signup wizard became the only way to bootstrap a real
 * install. Tests that historically called `seedIfEmpty(pool)` (often
 * via `process.env.ROOMY_SEED_USERNAME` / `ROOMY_SEED_PASSWORD`) should
 * call this helper directly with the same values as named options.
 *
 * Idempotent on already-seeded DBs: returns the existing row IDs
 * without inserting again.
 */
export async function insertSeedFixture(
  pool: Pool,
  opts: SeedFixtureOptions = {},
): Promise<SeedFixture> {
  const username = opts.username ?? "roomy";
  const password = opts.password ?? PUBLIC_SEED_PASSWORD;
  const email = opts.email ?? `${username}@roomy.local`;
  const mustChangePassword = password === PUBLIC_SEED_PASSWORD;

  const { rows: existing } = await pool.query<{ id: string }>(
    "SELECT id FROM users LIMIT 1",
  );
  if (existing.length > 0) {
    const userId = existing[0].id;
    const { rows: agents } = await pool.query<{ id: string }>(
      "SELECT id FROM agents WHERE user_id = ? LIMIT 1",
      [userId],
    );
    const { rows: workspaces } = await pool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE user_id = ? LIMIT 1",
      [userId],
    );
    return {
      userId,
      agentId: agents[0]?.id ?? "",
      workspaceId: workspaces[0]?.id ?? "",
      username,
      email,
      password,
      mustChangePassword,
    };
  }

  const userId = generateId("user");
  const agentId = generateId("agent");
  const workspaceId = generateId("workspace");
  const passwordHash = await hashPassword(password);

  transact(pool, (client) => {
    client.querySync(
      `INSERT INTO users (id, username, password_hash, email, must_change_password)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, username, passwordHash, email, mustChangePassword ? 1 : 0],
    );
    client.querySync(
      `INSERT INTO agents (id, user_id, name, model)
       VALUES (?, ?, ?, ?)`,
      [agentId, userId, "Roomy", "anthropic/claude-haiku-4-5"],
    );
    client.querySync(
      `INSERT INTO workspaces (id, user_id, name, path)
       VALUES (?, ?, ?, ?)`,
      [workspaceId, userId, "Roomy", "roomy"],
    );
    client.querySync(
      `INSERT INTO workspace_agents (workspace_id, agent_id)
       VALUES (?, ?)`,
      [workspaceId, agentId],
    );
  });

  return {
    userId,
    agentId,
    workspaceId,
    username,
    email,
    password,
    mustChangePassword,
  };
}
