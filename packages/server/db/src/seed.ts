import pg from "pg";
import { generateId, TOOLS, type ToolName } from "@desk/shared";
import { hashPassword } from "./passwords.js";

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
