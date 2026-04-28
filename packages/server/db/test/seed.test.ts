import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Pool, type PoolClient } from "../src/pool.js";
import { PROVIDER_KEY_VARS } from "@desk/shared";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import { seedIfEmpty, seedProviderKeysFromEnv } from "../src/seed.js";
import * as userSettings from "../src/queries/userSettings.js";
import { resetSecretKeyCache } from "../src/encryption.js";

let pool: Pool;
let keyDir: string;
let savedProviderKeys: Record<string, string | undefined>;

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
  // Snapshot and clear every provider env var so tests that exercise
  // seedProviderKeysFromEnv see only the keys they explicitly set.
  savedProviderKeys = {};
  for (const name of PROVIDER_KEY_VARS) {
    savedProviderKeys[name] = process.env[name];
    delete process.env[name];
  }
  // Wipe any provider keys rows so each test's encryption key is the
  // only one used against them.
  await pool.query("DELETE FROM user_settings");
});

afterEach(() => {
  delete process.env.DESK_SECRET_KEY_PATH;
  delete process.env.DESK_DEV;
  for (const [name, value] of Object.entries(savedProviderKeys)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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

    const { rows: users } = await pool.query("SELECT count(*)::int AS c FROM users");
    expect(users[0].c).toBe(1);

    const { rows: agents } = await pool.query("SELECT count(*)::int AS c FROM agents");
    expect(agents[0].c).toBe(1);

    const { rows: workspaces } = await pool.query("SELECT count(*)::int AS c FROM workspaces");
    expect(workspaces[0].c).toBe(1);
  });
});

describe("seedProviderKeysFromEnv", () => {
  it("is a no-op when DESK_DEV is not set", async () => {
    await seedIfEmpty(pool);
    process.env.ANTHROPIC_API_KEY = "sk-should-be-ignored";
    // DESK_DEV intentionally unset
    await seedProviderKeysFromEnv(pool);

    const { rows } = await pool.query("SELECT id FROM users LIMIT 1");
    const userId = rows[0].id as string;
    expect(await userSettings.getProviderKeys(pool, userId)).toEqual({});
  });

  it("copies set env vars into the DB when DESK_DEV=1", async () => {
    await seedIfEmpty(pool);
    process.env.DESK_DEV = "1";
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
    await seedProviderKeysFromEnv(pool);

    const { rows } = await pool.query("SELECT id FROM users LIMIT 1");
    const userId = rows[0].id as string;
    expect(await userSettings.getProviderKeys(pool, userId)).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-from-env",
    });
  });

  it("does not overwrite existing stored keys", async () => {
    await seedIfEmpty(pool);
    const { rows } = await pool.query("SELECT id FROM users LIMIT 1");
    const userId = rows[0].id as string;
    await userSettings.setProviderKeys(pool, userId, {
      ANTHROPIC_API_KEY: "user-chose-this",
    });

    process.env.DESK_DEV = "1";
    process.env.ANTHROPIC_API_KEY = "sk-env-value";
    await seedProviderKeysFromEnv(pool);

    expect(await userSettings.getProviderKeys(pool, userId)).toEqual({
      ANTHROPIC_API_KEY: "user-chose-this",
    });
  });
});
