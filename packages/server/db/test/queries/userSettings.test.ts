import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Pool } from "../../src/pool.js";
import { generateId } from "@desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as userSettings from "../../src/queries/userSettings.js";
import * as users from "../../src/queries/users.js";
import { resetSecretKeyCache } from "../../src/encryption.js";
import { hashPassword } from "../../src/passwords.js";

let pool: Pool;
let keyDir: string;
let prevEnv: string | undefined;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

beforeEach(() => {
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-usercfg-"));
  prevEnv = process.env.DESK_SECRET_KEY_PATH;
  process.env.DESK_SECRET_KEY_PATH = path.join(keyDir, "secret.key");
  resetSecretKeyCache();
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.DESK_SECRET_KEY_PATH;
  else process.env.DESK_SECRET_KEY_PATH = prevEnv;
  resetSecretKeyCache();
  fs.rmSync(keyDir, { recursive: true, force: true });
});

async function makeUser(username: string): Promise<string> {
  const id = generateId("user");
  await users.insert(pool, {
    id,
    username,
    passwordHash: await hashPassword("pw"),
    email: `${username}@example.com`,
  });
  return id;
}

describe("user_settings queries", () => {
  it("getProviderKeys returns empty object when no row exists", async () => {
    const id = await makeUser("no-settings-user");
    expect(await userSettings.getProviderKeys(pool, id)).toEqual({});
  });

  it("setProviderKeys writes encrypted bytes; getProviderKeys decrypts", async () => {
    const id = await makeUser("provider-user");
    const keys = { ANTHROPIC_API_KEY: "sk-ant-abc", OPENAI_API_KEY: "sk-oai-xyz" };
    await userSettings.setProviderKeys(pool, id, keys);

    const { rows } = await pool.query(
      "SELECT provider_keys_encrypted FROM user_settings WHERE user_id = ?",
      [id],
    );
    expect(rows.length).toBe(1);
    const ct = rows[0].provider_keys_encrypted as Buffer;
    // Encrypted bytes should never contain the plaintext value
    expect(ct.toString("utf8")).not.toContain("sk-ant-abc");
    expect(ct.toString("utf8")).not.toContain("sk-oai-xyz");

    expect(await userSettings.getProviderKeys(pool, id)).toEqual(keys);
  });

  it("setProviderKeys is a full overwrite", async () => {
    const id = await makeUser("overwrite-user");
    await userSettings.setProviderKeys(pool, id, {
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "o",
    });
    await userSettings.setProviderKeys(pool, id, { ANTHROPIC_API_KEY: "a2" });
    expect(await userSettings.getProviderKeys(pool, id)).toEqual({
      ANTHROPIC_API_KEY: "a2",
    });
  });

  it("mergeProviderKeys sets, updates, and deletes selectively", async () => {
    const id = await makeUser("merge-user");
    await userSettings.setProviderKeys(pool, id, {
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "o",
    });

    await userSettings.mergeProviderKeys(pool, id, {
      ANTHROPIC_API_KEY: "a2",
      GROQ_API_KEY: "g",
    });
    expect(await userSettings.getProviderKeys(pool, id)).toEqual({
      ANTHROPIC_API_KEY: "a2",
      OPENAI_API_KEY: "o",
      GROQ_API_KEY: "g",
    });

    await userSettings.mergeProviderKeys(pool, id, { OPENAI_API_KEY: null });
    expect(await userSettings.getProviderKeys(pool, id)).toEqual({
      ANTHROPIC_API_KEY: "a2",
      GROQ_API_KEY: "g",
    });
  });

  it("cascades on user delete", async () => {
    const id = await makeUser("cascade-user");
    await userSettings.setProviderKeys(pool, id, { ANTHROPIC_API_KEY: "x" });
    await pool.query("DELETE FROM users WHERE id = ?", [id]);
    const { rows } = await pool.query(
      "SELECT 1 FROM user_settings WHERE user_id = ?",
      [id],
    );
    expect(rows.length).toBe(0);
  });
});
