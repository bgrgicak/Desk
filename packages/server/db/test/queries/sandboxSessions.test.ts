import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { generateId } from "@desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as agents from "../../src/queries/agents.js";
import * as sandboxSessions from "../../src/queries/sandboxSessions.js";
import * as users from "../../src/queries/users.js";

let pool: pg.Pool;
let agentId: string;
let userId: string;

beforeAll(async () => {
  pool = await setupTestDb();
  userId = generateId("user");
  await users.insert(pool, {
    id: userId,
    username: "sbx-owner",
    passwordHash: "x",
    email: "sbx-owner@example.com",
  });
  agentId = generateId("agent");
  await agents.insert(pool, { id: agentId, userId, name: "SandboxAgent" });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("sandboxSessions queries", () => {
  const sessionId = generateId("sandboxSession");
  const tokenHash = "sha256_test_hash_abc123";

  it("issues a session", async () => {
    const session = await sandboxSessions.issue(pool, {
      id: sessionId,
      agentId,
      tokenHash,
    });
    expect(session.id).toBe(sessionId);
    expect(session.agentId).toBe(agentId);
    expect(session.tokenHash).toBe(tokenHash);
    expect(session.revokedAt).toBeUndefined();
  });

  it("finds by token hash", async () => {
    const session = await sandboxSessions.findByTokenHash(pool, tokenHash);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(sessionId);
  });

  it("revokes a session", async () => {
    const ok = await sandboxSessions.revoke(pool, sessionId);
    expect(ok).toBe(true);

    // Should no longer be found by token hash (revoked)
    const session = await sandboxSessions.findByTokenHash(pool, tokenHash);
    expect(session).toBeNull();
  });

  it("cascades delete when agent is deleted", async () => {
    const tempAgentId = generateId("agent");
    await agents.insert(pool, { id: tempAgentId, userId, name: "TempAgent" });
    const tempSessionId = generateId("sandboxSession");
    await sandboxSessions.issue(pool, {
      id: tempSessionId,
      agentId: tempAgentId,
      tokenHash: "temp_hash",
    });

    await pool.query("DELETE FROM agents WHERE id = $1", [tempAgentId]);

    const { rows } = await pool.query("SELECT * FROM sandbox_sessions WHERE id = $1", [tempSessionId]);
    expect(rows).toHaveLength(0);
  });
});
