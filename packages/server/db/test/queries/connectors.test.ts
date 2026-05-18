import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateId } from "@agent-desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as connectors from "../../src/queries/connectors.js";
import * as users from "../../src/queries/users.js";
import * as workspaces from "../../src/queries/workspaces.js";
import type { Pool } from "../../src/pool.js";

let pool: Pool;
let userId: string;
let workspaceId: string;

beforeAll(async () => {
  pool = await setupTestDb();
  userId = generateId("user");
  await users.insert(pool, {
    id: userId,
    username: "connector-user",
    passwordHash: "hash",
    email: "connector@example.com",
  });
  workspaceId = generateId("workspace");
  const wsPath = await workspaces.reserveWorkspacePath(pool, "Connector WS");
  await workspaces.insert(pool, { id: workspaceId, userId, name: "Connector WS", path: wsPath });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("connector queries", () => {
  it("stores multiple connections per provider and enforces one default per owner/provider", async () => {
    const first = await connectors.createConnection(pool, {
      ownerUserId: userId,
      providerId: "notion",
      displayName: "Personal Notion",
      externalAccountId: "bero@example.com",
      scopes: ["pages.read"],
      capabilities: ["notion.pages.read"],
      metadata: { email: "bero@example.com" },
      isDefault: true,
    });
    const second = await connectors.createConnection(pool, {
      ownerUserId: userId,
      providerId: "notion",
      displayName: "Work Notion",
      externalAccountId: "bero@work.example",
      capabilities: ["notion.databases.read"],
      isDefault: true,
    });

    const rows = await connectors.listConnections(pool, userId, "notion");
    expect(rows.map((r) => r.id).sort()).toEqual([first.id, second.id].sort());
    expect(rows.find((r) => r.id === first.id)?.isDefault).toBe(false);
    expect(rows.find((r) => r.id === second.id)?.isDefault).toBe(true);
    expect(rows.find((r) => r.id === first.id)?.metadata).toEqual({ email: "bero@example.com" });
    // Credentials are stored exclusively in the per-user vault, not on the
    // connection row. The connection schema is pure metadata.
    expect("credentials" in rows.find((r) => r.id === first.id)!).toBe(false);
    expect("credentialsEncrypted" in rows.find((r) => r.id === first.id)!).toBe(false);
  });

  it("updates a connection's metadata in place", async () => {
    const connection = await connectors.createConnection(pool, {
      ownerUserId: userId,
      providerId: "notion",
      displayName: "Notion",
      capabilities: ["notion.read"],
    });

    const patched = await connectors.updateConnection(pool, connection.id, userId, {
      displayName: "Notion (renamed)",
      status: "disabled",
    });
    expect(patched?.displayName).toBe("Notion (renamed)");
    expect(patched?.status).toBe("disabled");
  });

  it("replaces workspace grants and allows one default per provider", async () => {
    const slack = await connectors.createConnection(pool, {
      ownerUserId: userId,
      providerId: "slack",
      displayName: "Slack main",
      capabilities: ["slack.messages.read"],
    });
    const github = await connectors.createConnection(pool, {
      ownerUserId: userId,
      providerId: "github",
      displayName: "GitHub main",
      capabilities: ["github.repos.read"],
    });

    await connectors.replaceWorkspaceGrants(pool, workspaceId, userId, [
      { connectionId: slack.id, providerId: "slack", grantedCapabilities: ["slack.messages.read"], isDefault: true },
      { connectionId: github.id, providerId: "github", grantedCapabilities: ["github.repos.read"], isDefault: true },
    ]);
    const grants = await connectors.listWorkspaceGrants(pool, workspaceId);
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.providerId).sort()).toEqual(["github", "slack"]);
    expect(grants.every((g) => g.isDefault)).toBe(true);

    await connectors.replaceWorkspaceGrants(pool, workspaceId, userId, [
      { connectionId: slack.id, providerId: "slack", grantedCapabilities: ["slack.messages.read"] },
    ]);
    expect(await connectors.listWorkspaceGrants(pool, workspaceId)).toHaveLength(1);
  });
});
