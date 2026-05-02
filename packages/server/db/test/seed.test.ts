import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Pool } from "../src/pool.js";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import { seedIfEmpty } from "../src/seed.js";
import { resetSecretKeyCache } from "../src/encryption.js";

let pool: Pool;
let keyDir: string;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

beforeEach(async () => {
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-seed-"));
  process.env.DESK_SECRET_KEY_PATH = path.join(keyDir, "secret.key");
  resetSecretKeyCache();
  await pool.query("DELETE FROM user_settings");
});

afterEach(() => {
  delete process.env.DESK_SECRET_KEY_PATH;
  resetSecretKeyCache();
  fs.rmSync(keyDir, { recursive: true, force: true });
});

describe("seedIfEmpty", () => {
  it("seeds a user, agent, and workspace into an empty DB", async () => {
    await seedIfEmpty(pool);

    const { rows: users } = await pool.query("SELECT * FROM users");
    expect(users).toHaveLength(1);
    expect(users[0].username).toBe("desk");

    const { rows: agents } = await pool.query("SELECT * FROM agents");
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("Desk");

    const { rows: workspaces } = await pool.query("SELECT * FROM workspaces");
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].name).toBe("Desk");
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
