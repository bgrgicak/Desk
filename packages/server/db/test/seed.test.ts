import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { type Pool } from "../src/pool.js";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import { seedIfEmpty } from "../src/seed.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

beforeEach(async () => {
  await pool.query("DELETE FROM user_settings");
});

describe("seedIfEmpty", () => {
  it("seeds a user, agent, and workspace into an empty DB", async () => {
    await seedIfEmpty(pool);

    const { rows: users } = await pool.query("SELECT * FROM users");
    expect(users).toHaveLength(1);
    expect(users[0].username).toBe("roomy");

    const { rows: agents } = await pool.query("SELECT * FROM agents");
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("Roomy");

    const { rows: workspaces } = await pool.query("SELECT * FROM workspaces");
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].name).toBe("Roomy");
    expect(workspaces[0].user_id).toBe(users[0].id);
  });

  it("is idempotent — calling again does not duplicate rows", async () => {
    await seedIfEmpty(pool);

    const { rows: users } = await pool.query("SELECT count(*) AS c FROM users");
    expect(users[0].c).toBe(1);

    const { rows: agents } = await pool.query("SELECT count(*) AS c FROM agents");
    expect(agents[0].c).toBe(1);

    const { rows: workspaces } = await pool.query("SELECT count(*) AS c FROM workspaces");
    expect(workspaces[0].c).toBe(1);
  });
});
