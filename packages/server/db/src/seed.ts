import { type Pool, transact } from "./pool.js";
import { generateId } from "@agent-desk/shared";
import { hashPassword } from "./passwords.js";

export async function seedIfEmpty(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ c: number }>(
    "SELECT count(*) AS c FROM users",
  );
  if (rows[0].c > 0) return;

  const username = process.env.DESK_SEED_USERNAME ?? "desk";
  const password = process.env.DESK_SEED_PASSWORD ?? "change-me-before-first-boot";

  const userId = generateId("user");
  const agentId = generateId("agent");
  const workspaceId = generateId("workspace");

  // hashPassword is the only async work — done before the tx so the
  // tx callback stays synchronous.
  const passwordHash = await hashPassword(password);

  transact(pool, (client) => {
    client.querySync(
      `INSERT INTO users (id, username, password_hash, email)
       VALUES (?, ?, ?, ?)`,
      [userId, username, passwordHash, `${username}@desk.local`],
    );

    client.querySync(
      `INSERT INTO agents (id, user_id, name, instructions, model)
       VALUES (?, ?, ?, ?, ?)`,
      [
        agentId,
        userId,
        "Desk",
        "You are Desk, a helpful AI assistant.",
        "opencode/big-pickle",
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
