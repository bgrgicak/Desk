import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "../src/pool.js";
import { runMigrations } from "../src/migrate.js";
import { insertSeedFixture, PUBLIC_SEED_PASSWORD } from "../src/test-fixtures.js";
import * as users from "../src/queries/users.js";

let pool: Pool;
let dbDir: string;
let keyDir: string;
let prevEnvSecret: string | undefined;

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "roomy-mcp-"));
  pool = new Pool({ path: path.join(dbDir, "test.sqlite3") });
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
  fs.rmSync(dbDir, { recursive: true, force: true });
  if (prevEnvSecret === undefined) delete process.env.ROOMY_SECRET_KEY_PATH;
  else process.env.ROOMY_SECRET_KEY_PATH = prevEnvSecret;
});

beforeEach(() => {
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "roomy-mcp-key-"));
  prevEnvSecret = process.env.ROOMY_SECRET_KEY_PATH;
  process.env.ROOMY_SECRET_KEY_PATH = path.join(keyDir, "secret.key");
});

describe("must_change_password flag", () => {
  it("insertSeedFixture sets the flag when using the documented default password", async () => {
    await pool.query("DELETE FROM users", []);

    await insertSeedFixture(pool);

    const u = await users.findByUsername(pool, "roomy");
    expect(u).toBeTruthy();
    expect(u!.mustChangePassword).toBe(true);
  });

  it("insertSeedFixture does NOT set the flag when the operator supplies their own seed password", async () => {
    await pool.query("DELETE FROM users", []);

    await insertSeedFixture(pool, {
      username: "alice",
      password: "my-own-strong-password",
    });

    const u = await users.findByUsername(pool, "alice");
    expect(u).toBeTruthy();
    expect(u!.mustChangePassword).toBe(false);
  });

  it("setPassword clears the flag", async () => {
    await pool.query("DELETE FROM users", []);

    await insertSeedFixture(pool);
    const u = await users.findByUsername(pool, "roomy");
    expect(u!.mustChangePassword).toBe(true);

    await users.setPassword(pool, u!.id, PUBLIC_SEED_PASSWORD, "a-much-stronger-pw");

    const after = await users.findByUsername(pool, "roomy");
    expect(after!.mustChangePassword).toBe(false);
  });

  it("insert() defaults the flag to false", async () => {
    await pool.query("DELETE FROM users", []);
    const inserted = await users.insert(pool, {
      id: "usr_" + Math.random().toString(36).slice(2, 10),
      username: "bob",
      passwordHash: "$2b$10$placeholder",
      email: "bob@example.com",
    });
    expect(inserted.mustChangePassword).toBe(false);
  });

  it("insertSeedFixture is a no-op on an already-seeded DB and never flips the flag back", async () => {
    await pool.query("DELETE FROM users", []);
    await insertSeedFixture(pool);
    const seeded = await users.findByUsername(pool, "roomy");
    await users.setPassword(pool, seeded!.id, PUBLIC_SEED_PASSWORD, "now-rotated-pw");
    const beforeCleared = await users.findByUsername(pool, "roomy");
    expect(beforeCleared!.mustChangePassword).toBe(false);

    await insertSeedFixture(pool);
    const after = await users.findByUsername(pool, "roomy");
    expect(after!.id).toBe(beforeCleared!.id);
    expect(after!.mustChangePassword).toBe(false);
  });
});
