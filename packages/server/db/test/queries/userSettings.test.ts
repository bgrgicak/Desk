import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateId } from "@agent-desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as userSettings from "../../src/queries/userSettings.js";
import * as users from "../../src/queries/users.js";
import { hashPassword } from "../../src/passwords.js";
import type { Pool } from "../../src/pool.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
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
  it("getProviderMeta returns empty object when no row exists", async () => {
    const id = await makeUser("no-meta-user");
    expect(await userSettings.getProviderMeta(pool, id)).toEqual({});
  });

  it("mergeProviderMeta sets and updates entries selectively", async () => {
    const id = await makeUser("meta-user");
    await userSettings.mergeProviderMeta(pool, id, {
      OPENAI_API_KEY: { enabled: false },
      GEMINI_API_KEY: { enabled: true, name: "Gemini" },
    });
    const meta = await userSettings.getProviderMeta(pool, id);
    expect(meta.OPENAI_API_KEY?.enabled).toBe(false);
    expect(meta.GEMINI_API_KEY?.enabled).toBe(true);
    expect(meta.GEMINI_API_KEY?.name).toBe("Gemini");

    // Partial update leaves other keys alone
    await userSettings.mergeProviderMeta(pool, id, { OPENAI_API_KEY: { enabled: true } });
    const updated = await userSettings.getProviderMeta(pool, id);
    expect(updated.OPENAI_API_KEY?.enabled).toBe(true);
    expect(updated.GEMINI_API_KEY?.enabled).toBe(true);
  });

  it("cascades on user delete", async () => {
    const id = await makeUser("cascade-user");
    await userSettings.mergeProviderMeta(pool, id, { GEMINI_API_KEY: { enabled: true } });
    await pool.query("DELETE FROM users WHERE id = ?", [id]);
    const { rows } = await pool.query(
      "SELECT 1 FROM user_settings WHERE user_id = ?",
      [id],
    );
    expect(rows.length).toBe(0);
  });
});
