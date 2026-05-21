import { type Pool, transact } from "./pool.js";
import { generateId } from "@agent-desk/shared";
import { hashPassword } from "./passwords.js";

export async function seedIfEmpty(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ c: number }>(
    "SELECT count(*) AS c FROM users",
  );
  if (rows[0].c > 0) return;

  const username = process.env.DESK_SEED_USERNAME ?? "desk";
  const SEED_PASSWORD = "change-me-before-first-boot";
  const password = process.env.DESK_SEED_PASSWORD ?? SEED_PASSWORD;
  // Flag only the install that's still on the documented public seed
  // password. Operators who explicitly set DESK_SEED_PASSWORD chose
  // their own secret and don't need a "must change" prompt.
  const mustChangePassword = password === SEED_PASSWORD ? 1 : 0;

  const userId = generateId("user");
  const agentId = generateId("agent");
  const workspaceId = generateId("workspace");

  // hashPassword is the only async work — done before the tx so the
  // tx callback stays synchronous.
  const passwordHash = await hashPassword(password);

  transact(pool, (client) => {
    client.querySync(
      `INSERT INTO users (id, username, password_hash, email, must_change_password)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, username, passwordHash, `${username}@desk.local`, mustChangePassword],
    );

    client.querySync(
      `INSERT INTO agents (id, user_id, name, model)
       VALUES (?, ?, ?, ?)`,
      [
        agentId,
        userId,
        "Desk",
        "anthropic/claude-haiku-4-5",
      ],
    );

    client.querySync(
      `INSERT INTO workspaces (id, user_id, name, path)
       VALUES (?, ?, ?, ?)`,
      [workspaceId, userId, "Desk", "desk"],
    );

    client.querySync(
      `INSERT INTO workspace_agents (workspace_id, agent_id)
       VALUES (?, ?)`,
      [workspaceId, agentId],
    );
  });
}
