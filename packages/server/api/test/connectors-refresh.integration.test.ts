/**
 * Integration test for the connection-refresh wiring.
 *
 * After a connector / local-source mutation, the API layer must:
 *   1. Null out the user's persisted pi session ids so the
 *      next chat turn binds providerID/modelID/auth fresh.
 *   2. Broadcast a `connection.changed` WS event so any open client
 *      refetches its connection list.
 *   3. Best-effort restart the sandbox daemons (covered by runtime
 *      tests; here we just assert it doesn't crash when no engine /
 *      no container is present, since this test runs without Docker).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations, insertSeedFixture, queries } from "@roomy-ai/db";
import { ensureLayout } from "@roomy-ai/storage";
import { createRunManager } from "@roomy-ai/scheduler";
import {
  buildDaemonEnv,
  rawSandboxCredentialEnvEnabled,
  refreshSandboxConnections,
  resolveLocalSourceEnv,
} from "@roomy-ai/runtime";
import { generateId, type WsEvent } from "@roomy-ai/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { addConnection, clearConnections } from "../src/ws/registry.js";
import { resolveProviderKeys } from "../src/providerKeys.js";
import { VaultStore } from "../src/vault/store.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let dbPath: string;
let vault: VaultStore;
let userId: string;
let token: string;
let workspaceId: string;
let agentId: string;
// Captures every userId passed to refreshSandboxConnections so tests can
// assert the agent-model-change path actually triggers the same daemon-
// restart pipeline used by connection mutations.
const refreshCalls: Array<{ userId: string; workspaceId: string | undefined }> = [];

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-connref-api-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  await insertSeedFixture(pool, { username: "connref-api", password: "connref-pass" });

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-connref-api-home-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;
  const { rows: userRows } = await pool.query<{ id: string }>("SELECT id FROM users LIMIT 1");
  userId = userRows[0].id;
  vault = new VaultStore(path.join(home, ".vaults"));
  await vault.setup(userId, "connref-test-vault");

  const runManager = createRunManager({
    pool,
    execRunFn: async (runId, _agentId, _prompt, onLog) => {
      await onLog({ runId, seq: 0, kind: "stdout", payload: "" });
      return { exitCode: 0 };
    },
    resolveProviderKeys: (uid, wsId) => resolveProviderKeys(pool, vault, uid, wsId),
  });

  server = createApp({
    pool,
    storage: { pool, home },
    runManager,
    broadcastUserId: userId,
    vault,
    // Real refresh callback. Without Docker this will hit the "engine
    // unavailable" branch — that's exactly the path we want covered:
    // sessions still clear, the route still succeeds.
    refreshSandboxConnections: async (uid, wsId) => {
      refreshCalls.push({ userId: uid, workspaceId: wsId });
      await refreshSandboxConnections({
        pool,
        userId: uid,
        workspaceId: wsId,
        buildSandboxEnv: async (innerUid, innerWsId) => {
          const providerKeys = rawSandboxCredentialEnvEnabled()
            ? await resolveProviderKeys(pool, vault, innerUid, innerWsId)
            : {};
          const extraEnv = await resolveLocalSourceEnv(pool, innerUid);
          return buildDaemonEnv({ providerKeys, extraEnv });
        },
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  // Login + create a workspace + chat with a stamped pi session id.
  const login = await request("POST", "/auth/login", undefined, {
    email: "connref-api@roomy.local", password: "connref-pass",
  });
  token = login.body.token;
  const ws = await request("POST", "/workspaces", token, { name: "Refresh WS" });
  workspaceId = ws.body.id;
  // Grab the seeded agent so the chat insert validation passes.
  const agents = await request("GET", "/agents", token);
  agentId = agents.body[0].id;
  // The seed adds the agent to its first workspace; manually attach to ours.
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
    [workspaceId, agentId],
  );
});

afterAll(async () => {
  await clearSessions(pool);
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
});

interface JsonResponse { status: number; body: any }

function request(
  method: string,
  urlPath: string,
  authToken?: string,
  body?: unknown,
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
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

async function makeChatWithSession(sessionId: string): Promise<string> {
  const chatId = generateId("chat");
  await queries.chats.insert(pool, {
    id: chatId,
    workspaceId,
    agentId,
    title: "test chat",
  });
  await queries.chats.setPiSessionId(pool, chatId, sessionId);
  return chatId;
}

async function grantDefaultConnectionToWorkspace(providerId: string): Promise<void> {
  const listed = await request("GET", `/me/connections?providerId=${encodeURIComponent(providerId)}`, token);
  const connection = (listed.body.connections as Array<{ id: string; providerId: string; isDefault: boolean }>).find((c) => c.isDefault)
    ?? listed.body.connections[0];
  expect(connection).toBeDefined();
  const granted = await request("PUT", `/workspaces/${workspaceId}/connections`, token, {
    grants: [{ connectionId: connection.id, providerId, grantedCapabilities: [], isDefault: true }],
  });
  expect(granted.status).toBe(200);
}

/** A tiny WS-like collector that the registry will treat as an open socket. */
class CapturingWs {
  readyState = 1;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

describe("connection-mutation refresh wiring", () => {
  it("clears the user's pi sessions when a connection is created", async () => {
    const chatId = await makeChatWithSession("ses_create_before");
    expect(await queries.chats.getPiSessionId(pool, chatId)).toBe("ses_create_before");

    const created = await request("POST", "/me/connections", token, {
      providerId: "github",
      displayName: "GH for refresh",
      credentials: { token: "ghp_test_create" },
    });
    expect(created.status).toBe(201);

    expect(await queries.chats.getPiSessionId(pool, chatId)).toBeNull();
  });

  it("clears sessions when a connection is updated", async () => {
    const created = await request("POST", "/me/connections", token, {
      providerId: "OPENAI_API_KEY",
      displayName: "OpenAI for update",
      credentials: { value: "sk-old" },
    });
    expect(created.status).toBe(201);
    const connId = created.body.connection.id;

    const chatId = await makeChatWithSession("ses_update_before");

    const patched = await request("PATCH", `/me/connections/${connId}`, token, {
      credentials: { value: "sk-new" },
    });
    expect(patched.status).toBe(200);

    expect(await queries.chats.getPiSessionId(pool, chatId)).toBeNull();
  });

  it("clears sessions when a connection is deleted", async () => {
    const created = await request("POST", "/me/connections", token, {
      providerId: "ANTHROPIC_API_KEY",
      displayName: "Anthropic for delete",
      credentials: { value: "sk-ant-temp" },
    });
    expect(created.status).toBe(201);
    const connId = created.body.connection.id;

    const chatId = await makeChatWithSession("ses_delete_before");

    const deleted = await request("DELETE", `/me/connections/${connId}`, token);
    expect(deleted.status).toBe(200);

    expect(await queries.chats.getPiSessionId(pool, chatId)).toBeNull();
  });

  it("clears sessions when a local source is toggled off", async () => {
    // Enable codex first so we have a state to flip.
    await request("PUT", "/me/providers/local/codex", token, { enabled: true });
    const chatId = await makeChatWithSession("ses_codex_before");

    const toggled = await request("PUT", "/me/providers/local/codex", token, { enabled: false });
    expect(toggled.status).toBe(200);

    expect(await queries.chats.getPiSessionId(pool, chatId)).toBeNull();
  });

  it("scopes session clearing to one workspace when a workspace grant is replaced", async () => {
    // Create a second workspace and a chat in each, both with a session.
    const otherWs = await request("POST", "/workspaces", token, { name: "Other WS" });
    const otherWorkspaceId = otherWs.body.id;
    await pool.query(
      `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
      [otherWorkspaceId, agentId],
    );

    const chatInTarget = generateId("chat");
    const chatInOther = generateId("chat");
    await queries.chats.insert(pool, { id: chatInTarget, workspaceId, agentId, title: "target" });
    await queries.chats.insert(pool, { id: chatInOther, workspaceId: otherWorkspaceId, agentId, title: "other" });
    await queries.chats.setPiSessionId(pool, chatInTarget, "ses_target");
    await queries.chats.setPiSessionId(pool, chatInOther, "ses_other");

    // Need a connection to grant.
    const conn = await request("POST", "/me/connections", token, {
      providerId: "slack",
      displayName: "Slack for grant",
      credentials: { token: "xoxb" },
    });
    const connId = conn.body.connection.id;
    // Connection creation already cleared sessions; reseed both before testing the grant call.
    await queries.chats.setPiSessionId(pool, chatInTarget, "ses_target_again");
    await queries.chats.setPiSessionId(pool, chatInOther, "ses_other_again");

    const grants = await request("PUT", `/workspaces/${workspaceId}/connections`, token, {
      grants: [
        { connectionId: connId, providerId: "slack", grantedCapabilities: [], isDefault: true },
      ],
    });
    expect(grants.status).toBe(200);

    expect(await queries.chats.getPiSessionId(pool, chatInTarget)).toBeNull();
    expect(await queries.chats.getPiSessionId(pool, chatInOther)).toBe("ses_other_again");
  });

  it("emits a `connection.changed` WS event after each mutation", async () => {
    const ws = new CapturingWs();
    addConnection(userId, ws);

    await request("POST", "/me/connections", token, {
      providerId: "github",
      displayName: "GH for ws event",
      credentials: { token: "ghp_event" },
    });

    const events: WsEvent[] = ws.sent.map((s) => JSON.parse(s));
    const connectionChanged = events.find((e) => e.type === "connection.changed");
    expect(connectionChanged).toBeDefined();
    if (connectionChanged && connectionChanged.type === "connection.changed") {
      expect(connectionChanged.payload).toMatchObject({
        kind: "connector",
        providerId: "github",
        op: "created",
      });
    }
  });
});

/**
 * Regression suite for the "I added a GitHub PAT but the sandbox can't
 * see it" bug. The Settings UI saves GitHub tokens through legacy PUT
 * /me/providers (not POST /me/connections), and the resolver previously
 * skipped GITHUB_TOKEN entirely — and the legacy route didn't trigger a
 * connection refresh. End result: the token landed in the DB/vault but
 * never reached pi.
 *
 * These tests cover both halves of the fix:
 *   - PUT /me/providers writes the token in a shape resolveProviderKeys
 *     actually finds. buildDaemonEnv keeps raw credential env closed by
 *     default, and only emits the canonical env var and managed alias under
 *     the explicit raw-env opt-in.
 *   - PUT /me/providers (and /me/providers/meta) triggers the same
 *     refresh wiring as POST /me/connections (session clear + WS
 *     broadcast).
 */
describe("legacy /me/providers — sandbox env propagation", () => {
  it("keeps GITHUB_TOKEN workspace-local until the workspace grants the saved connection", async () => {
    const put = await request("PUT", "/me/providers", token, {
      providers: { GITHUB_TOKEN: "ghp_legacy_resolves" },
    });
    expect(put.status).toBe(200);
    const oldGlobalDisable = await request("PUT", "/me/providers/meta", token, {
      meta: { GITHUB_TOKEN: { enabled: false } },
    });
    expect(oldGlobalDisable.status).toBe(200);

    const beforeGrant = await resolveProviderKeys(pool, vault, userId, workspaceId);
    expect(beforeGrant.GITHUB_TOKEN).toBeUndefined();

    await grantDefaultConnectionToWorkspace("GITHUB_TOKEN");

    const afterGrant = await resolveProviderKeys(pool, vault, userId, workspaceId);
    expect(afterGrant.GITHUB_TOKEN).toBe("ghp_legacy_resolves");
  });

  it("buildDaemonEnv only mirrors GITHUB_TOKEN to GH_TOKEN under raw-env opt-in", async () => {
    await request("PUT", "/me/providers", token, {
      providers: { GITHUB_TOKEN: "ghp_alias_value" },
    });
    await grantDefaultConnectionToWorkspace("GITHUB_TOKEN");

    const providerKeys = await resolveProviderKeys(pool, vault, userId, workspaceId);
    const defaultEnv = buildDaemonEnv({ providerKeys });
    expect(defaultEnv.GITHUB_TOKEN).toBe("");
    expect(defaultEnv.GH_TOKEN).toBe("");

    const previous = process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
    process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV = "1";
    try {
      const optedInEnv = buildDaemonEnv({ providerKeys });
      expect(optedInEnv.GITHUB_TOKEN).toBe("ghp_alias_value");
      expect(optedInEnv.GH_TOKEN).toBe("ghp_alias_value");
    } finally {
      if (previous === undefined) delete process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
      else process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV = previous;
    }
  });

  it("clears sessions and broadcasts when PUT /me/providers saves a key", async () => {
    const chatId = await makeChatWithSession("ses_put_providers");
    const ws = new CapturingWs();
    addConnection(userId, ws);

    const put = await request("PUT", "/me/providers", token, {
      providers: { GITHUB_TOKEN: "ghp_triggers_refresh" },
    });
    expect(put.status).toBe(200);

    expect(await queries.chats.getPiSessionId(pool, chatId)).toBeNull();
    const events: WsEvent[] = ws.sent.map((s) => JSON.parse(s));
    const connectionChanged = events.find((e) => e.type === "connection.changed");
    expect(connectionChanged).toBeDefined();
  });

  it("clears sessions when PUT /me/providers/meta toggles a provider", async () => {
    // Seed a key so the toggle has something meaningful to flip.
    await request("PUT", "/me/providers", token, {
      providers: { ANTHROPIC_API_KEY: "sk-ant-toggle" },
    });
    const chatId = await makeChatWithSession("ses_put_meta");

    const meta = await request("PUT", "/me/providers/meta", token, {
      meta: { ANTHROPIC_API_KEY: { enabled: false } },
    });
    expect(meta.status).toBe(200);

    expect(await queries.chats.getPiSessionId(pool, chatId)).toBeNull();

    // Disabled providers must not appear in the resolved env — otherwise
    // the Settings toggle is purely cosmetic and the daemon still sees
    // the key.
    const resolved = await resolveProviderKeys(pool, vault, userId, workspaceId);
    expect(resolved.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

/**
 * Regression suite for the "I changed my agent's model in Settings but
 * the sandbox keeps using the old model" bug. pi reads each
 * agent file's `model:` field into an in-memory cache at daemon startup
 * and ignores subsequent rewrites — and it also ignores per-message
 * `providerID` / `modelID` overrides whenever an `agent` is bound to
 * the session. So changing `agent.model` in Roomy only propagates after
 * the daemon restarts. PATCH /agents/:id therefore must run the same
 * daemon-refresh pipeline used by connection mutations.
 */
describe("PATCH /agents/:id — daemon refresh on model change", () => {
  it("clears sessions for chats using the agent when its model changes", async () => {
    const chatId = await makeChatWithSession("ses_agent_model_change");
    expect(await queries.chats.getPiSessionId(pool, chatId)).toBe("ses_agent_model_change");

    const before = await request("GET", `/agents/${agentId}`, token);
    const previousModel = before.body.model;
    const newModel = previousModel === "anthropic/claude-haiku-4-5"
      ? "anthropic/claude-sonnet-4-6"
      : "anthropic/claude-haiku-4-5";

    const patched = await request("PATCH", `/agents/${agentId}`, token, { model: newModel });
    expect(patched.status).toBe(200);
    expect(patched.body.model).toBe(newModel);

    expect(await queries.chats.getPiSessionId(pool, chatId)).toBeNull();
  });

  it("triggers refreshSandboxConnections so daemons re-read the updated agent file", async () => {
    // The pi runtime caches each agent's `model:` at startup
    // and never re-reads the file. Without a daemon restart, a new
    // session created in the same daemon still inherits the cached
    // (stale) agent config. So clearing chat sessions is necessary but
    // NOT sufficient — this test pins the daemon-restart side of the fix.
    refreshCalls.length = 0;

    // Force a real model flip even if the previous test left the agent
    // at the "new" value already.
    const before = await request("GET", `/agents/${agentId}`, token);
    const flipped = before.body.model === "anthropic/claude-haiku-4-5"
      ? "anthropic/claude-sonnet-4-6"
      : "anthropic/claude-haiku-4-5";

    const patched = await request("PATCH", `/agents/${agentId}`, token, { model: flipped });
    expect(patched.status).toBe(200);

    // Allow the fire-and-forget refresh to complete. The handler awaits
    // patchAgent but kicks refreshSandboxConnections asynchronously so a
    // Docker hiccup can't stall the HTTP response — that means the test
    // needs a microtask boundary before asserting.
    await new Promise((r) => setImmediate(r));

    expect(refreshCalls.length).toBeGreaterThanOrEqual(1);
    expect(refreshCalls.at(-1)).toEqual({ userId, workspaceId: undefined });
  });

  it("does NOT trigger a daemon refresh when only the name changes", async () => {
    refreshCalls.length = 0;

    const patched = await request("PATCH", `/agents/${agentId}`, token, { name: "Renamed Agent" });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe("Renamed Agent");

    await new Promise((r) => setImmediate(r));

    // Renaming doesn't affect the daemon's agent cache (model: field is
    // unchanged), so we must not pay the daemon-restart cost or churn
    // the user's chat sessions.
    expect(refreshCalls.length).toBe(0);
  });

  it("does NOT trigger a daemon refresh when the model is unchanged", async () => {
    refreshCalls.length = 0;

    const before = await request("GET", `/agents/${agentId}`, token);
    const sameModel = before.body.model;

    const patched = await request("PATCH", `/agents/${agentId}`, token, { model: sameModel });
    expect(patched.status).toBe(200);

    await new Promise((r) => setImmediate(r));

    expect(refreshCalls.length).toBe(0);
  });
});
