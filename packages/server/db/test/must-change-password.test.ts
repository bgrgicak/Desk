import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "../src/pool.js";
import { runMigrations } from "../src/migrate.js";
import { seedIfEmpty } from "../src/seed.js";
import * as users from "../src/queries/users.js";

let pool: Pool;
let dbDir: string;
let keyDir: string;
let prevEnvSecret: string | undefined;
let prevEnvSeedUsername: string | undefined;
let prevEnvSeedPassword: string | undefined;

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
  prevEnvSeedUsername = process.env.ROOMY_SEED_USERNAME;
  prevEnvSeedPassword = process.env.ROOMY_SEED_PASSWORD;
  process.env.ROOMY_SECRET_KEY_PATH = path.join(keyDir, "secret.key");
});

describe("must_change_password flag", () => {
  it("seedIfEmpty sets the flag when using the documented default password", async () => {
    // Reset table to ensure seed runs.
    await pool.query("DELETE FROM users", []);
    delete process.env.ROOMY_SEED_USERNAME;
    delete process.env.ROOMY_SEED_PASSWORD;

    await seedIfEmpty(pool);

    const u = await users.findByUsername(pool, "roomy");
    expect(u).toBeTruthy();
    expect(u!.mustChangePassword).toBe(true);

    // Restore.
    if (prevEnvSeedUsername !== undefined) process.env.ROOMY_SEED_USERNAME = prevEnvSeedUsername;
    if (prevEnvSeedPassword !== undefined) process.env.ROOMY_SEED_PASSWORD = prevEnvSeedPassword;
  });

  it("seedIfEmpty does NOT set the flag when the operator supplies their own seed password", async () => {
    await pool.query("DELETE FROM users", []);
    process.env.ROOMY_SEED_USERNAME = "alice";
    process.env.ROOMY_SEED_PASSWORD = "my-own-strong-password";

    await seedIfEmpty(pool);

    const u = await users.findByUsername(pool, "alice");
    expect(u).toBeTruthy();
    expect(u!.mustChangePassword).toBe(false);

    if (prevEnvSeedUsername !== undefined) process.env.ROOMY_SEED_USERNAME = prevEnvSeedUsername;
    else delete process.env.ROOMY_SEED_USERNAME;
    if (prevEnvSeedPassword !== undefined) process.env.ROOMY_SEED_PASSWORD = prevEnvSeedPassword;
    else delete process.env.ROOMY_SEED_PASSWORD;
  });

  it("setPassword clears the flag", async () => {
    await pool.query("DELETE FROM users", []);
    delete process.env.ROOMY_SEED_USERNAME;
    delete process.env.ROOMY_SEED_PASSWORD;

    await seedIfEmpty(pool);
    const u = await users.findByUsername(pool, "roomy");
    expect(u!.mustChangePassword).toBe(true);

    await users.setPassword(pool, u!.id, "change-me-before-first-boot", "a-much-stronger-pw");

    const after = await users.findByUsername(pool, "roomy");
    expect(after!.mustChangePassword).toBe(false);

    if (prevEnvSeedUsername !== undefined) process.env.ROOMY_SEED_USERNAME = prevEnvSeedUsername;
    if (prevEnvSeedPassword !== undefined) process.env.ROOMY_SEED_PASSWORD = prevEnvSeedPassword;
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

  it("seedIfEmpty is a no-op on an already-seeded DB and never flips the flag back", async () => {
    // Set up state: one user already exists with mustChangePassword=0
    // (they previously changed their password).
    await pool.query("DELETE FROM users", []);
    delete process.env.ROOMY_SEED_USERNAME;
    delete process.env.ROOMY_SEED_PASSWORD;
    await seedIfEmpty(pool);
    const seeded = await users.findByUsername(pool, "roomy");
    await users.setPassword(pool, seeded!.id, "change-me-before-first-boot", "now-rotated-pw");
    const beforeCleared = await users.findByUsername(pool, "roomy");
    expect(beforeCleared!.mustChangePassword).toBe(false);

    // Re-run seedIfEmpty — should be a complete no-op.
    await seedIfEmpty(pool);
    const after = await users.findByUsername(pool, "roomy");
    expect(after!.id).toBe(beforeCleared!.id); // same row
    expect(after!.mustChangePassword).toBe(false); // flag stays cleared
  });
});
