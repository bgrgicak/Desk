import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations, seedIfEmpty } from "@roomy-ai/db";
import { ensureLayout } from "@roomy-ai/storage";
import { createRunManager } from "@roomy-ai/scheduler";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";
import { resolveProviderKeys } from "../src/providerKeys.js";
import { VaultStore } from "../src/vault/store.js";
import { credentialTitle } from "../src/connectors/credentialStore.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let vault: VaultStore;
let userId: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-connectors-api-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.ROOMY_SEED_USERNAME = "connector-api";
  process.env.ROOMY_SEED_PASSWORD = "connector-pass";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-connectors-api-home-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;
  const storage = { pool, home };
  const runManager = createRunManager({
    pool,
    execRunFn: async (_runId, _agentId, _prompt, onLog) => {
      await onLog({ runId: _runId, seq: 0, kind: "stdout", payload: "" });
      return { exitCode: 0 };
    },
  });

  const { rows: userRows } = await pool.query<{ id: string }>("SELECT id FROM users LIMIT 1");
  userId = userRows[0].id;
  vault = new VaultStore(path.join(home, ".vaults"));
  await vault.setup(userId, "connector-test-vault");
  server = createApp({ pool, storage, runManager, broadcastUserId: userId, vault });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await clearSessions(pool);
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
});

function request(method: string, urlPath: string, token?: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));
    const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestText(method: string, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("connector connection routes", () => {
  let token: string;
  let workspaceId: string;

  beforeAll(async () => {
    const login = await request("POST", "/auth/login", undefined, { username: "connector-api", password: "connector-pass" });
    token = login.body.token;
    const ws = await request("POST", "/workspaces", token, { name: "Connector Grants" });
    workspaceId = ws.body.id;
  });

  it("creates connections, stores credentials in the vault, and grants them to a workspace", async () => {
    const slack = await request("POST", "/me/connections", token, {
      providerId: "slack",
      displayName: "Main Slack",
      capabilities: ["slack.messages.read"],
      credentials: { token: "slack-bot-token" },
    });
    expect(slack.status).toBe(201);
    expect(slack.body.connection).toMatchObject({
      providerId: "slack",
      displayName: "Main Slack",
      hasCredentials: true,
    });

    // Connection row carries no credentials field.
    const listed = await request("GET", "/me/connections?providerId=slack", token);
    expect(listed.body.connections[0]).not.toHaveProperty("credentials");
    expect(listed.body.connections[0]).not.toHaveProperty("credentialsEncrypted");
    expect(listed.body.connections[0].hasCredentials).toBe(true);

    // Database has no encrypted credential/metadata columns at all.
    const cols = await pool.query<{ name: string }>("PRAGMA table_info(connector_connections)");
    expect(cols.rows.map((r) => r.name)).not.toContain("credentials_encrypted");
    expect(cols.rows.map((r) => r.name)).not.toContain("metadata_encrypted");

    // Vault has the entry under the canonical title.
    const stored = vault.get(userId, credentialTitle(userId, "slack", slack.body.connection.id));
    expect(stored?.password).toBe(JSON.stringify({ token: "slack-bot-token" }));

    // Grant it to a workspace.
    const grants = await request("PUT", `/workspaces/${workspaceId}/connections`, token, {
      grants: [
        {
          connectionId: slack.body.connection.id,
          providerId: "slack",
          grantedCapabilities: ["slack.messages.read"],
          isDefault: true,
        },
      ],
    });
    expect(grants.status).toBe(200);
    expect(grants.body.grants).toHaveLength(1);

    // Delete cleans up vault.
    await request("DELETE", `/me/connections/${slack.body.connection.id}`, token);
    expect(vault.get(userId, credentialTitle(userId, "slack", slack.body.connection.id))).toBeNull();
  });

  it("supports multiple connections of the same provider with one default", async () => {
    const a = await request("POST", "/me/connections", token, {
      providerId: "openai",
      displayName: "Personal OpenAI",
      isDefault: true,
      credentials: { value: "sk-personal" },
    });
    const b = await request("POST", "/me/connections", token, {
      providerId: "openai",
      displayName: "Work OpenAI",
      isDefault: true,
      credentials: { value: "sk-work" },
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const listed = await request("GET", "/me/connections?providerId=openai", token);
    const ids = listed.body.connections.map((c: { id: string; isDefault: boolean }) => [c.id, c.isDefault]);
    // Latest isDefault wins; the previous default is demoted to false.
    expect(ids).toEqual(expect.arrayContaining([
      [b.body.connection.id, true],
      [a.body.connection.id, false],
    ]));
  });

  it("rejects credential writes with 423 when the vault is locked", async () => {
    vault.lock(userId);
    try {
      const blocked = await request("POST", "/me/connections", token, {
        providerId: "notion",
        displayName: "Notion",
        credentials: { value: "secret" },
      });
      expect(blocked.status).toBe(423);
      expect((blocked.body as { code: string }).code).toBe("VAULT_LOCKED");
      // No row should have been created.
      const listed = await request("GET", "/me/connections?providerId=notion", token);
      expect(listed.body.connections).toHaveLength(0);
    } finally {
      await vault.unlock(userId, "connector-test-vault");
    }
  });

  it("PUT /me/providers returns 423 when the vault is locked", async () => {
    vault.lock(userId);
    try {
      const blocked = await request("PUT", "/me/providers", token, {
        providers: { OPENAI_API_KEY: "sk-test-123" },
      });
      expect(blocked.status).toBe(423);
      expect((blocked.body as { code: string }).code).toBe("VAULT_LOCKED");
      // Nothing should have been persisted while locked.
      const listed = await request("GET", "/me/connections?providerId=OPENAI_API_KEY", token);
      expect(listed.body.connections).toHaveLength(0);
    } finally {
      await vault.unlock(userId, "connector-test-vault");
    }
  });

  it("backs the legacy /me/providers endpoint with vault-stored connector connections", async () => {
    const saved = await request("PUT", "/me/providers", token, {
      providers: { GEMINI_API_KEY: "gemini-secret" },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.providers.GEMINI_API_KEY).toContain("...");

    const listed = await request("GET", "/me/connections?providerId=GEMINI_API_KEY", token);
    expect(listed.body.connections).toHaveLength(1);
    expect(listed.body.connections[0].hasCredentials).toBe(true);
    const stored = vault.get(userId, credentialTitle(userId, "GEMINI_API_KEY", listed.body.connections[0].id));
    expect(stored?.password).toBe(JSON.stringify({ value: "gemini-secret" }));

    const resolved = await resolveProviderKeys(pool, vault, userId);
    expect(resolved.GEMINI_API_KEY).toBe("gemini-secret");

    const cleared = await request("PUT", "/me/providers", token, { providers: { GEMINI_API_KEY: null } });
    expect(cleared.status).toBe(200);
    expect((await request("GET", "/me/connections?providerId=GEMINI_API_KEY", token)).body.connections).toHaveLength(0);
  });

  it("stores one shared credential per model provider key", async () => {
    await request("PUT", "/me/providers", token, { providers: { ANTHROPIC_API_KEY: null } });

    const first = await request("PUT", "/me/providers", token, {
      providers: { ANTHROPIC_API_KEY: "sk-ant-provider-first" },
    });
    expect(first.status).toBe(200);

    const firstListed = await request("GET", "/me/connections?providerId=ANTHROPIC_API_KEY", token);
    expect(firstListed.body.connections).toHaveLength(1);
    const connectionId = firstListed.body.connections[0].id as string;

    const second = await request("PUT", "/me/providers", token, {
      providers: { ANTHROPIC_API_KEY: "sk-ant-provider-second" },
    });
    expect(second.status).toBe(200);

    const secondListed = await request("GET", "/me/connections?providerId=ANTHROPIC_API_KEY", token);
    expect(secondListed.body.connections).toHaveLength(1);
    expect(secondListed.body.connections[0].id).toBe(connectionId);

    const stored = vault.get(userId, credentialTitle(userId, "ANTHROPIC_API_KEY", connectionId));
    expect(stored?.password).toBe(JSON.stringify({ value: "sk-ant-provider-second" }));

    const resolved = await resolveProviderKeys(pool, vault, userId);
    expect(resolved.ANTHROPIC_API_KEY).toBe("sk-ant-provider-second");
  });


  it("validates connector payloads", async () => {
    const missing = await request("POST", "/me/connections", token, {});
    expect(missing.status).toBe(400);

    const invalidArray = await request("POST", "/me/connections", token, {
      providerId: "github",
      displayName: "GitHub",
      scopes: ["repo", 7],
    });
    expect(invalidArray.status).toBe(400);
  });
});
