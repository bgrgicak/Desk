/**
 * Integration test for the connection-refresh wiring.
 *
 * After a connector / local-source mutation, the API layer must:
 *   1. Null out the user's persisted opencode-serve session ids so the
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
import { Pool, runMigrations, seedIfEmpty, queries } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createRunManager } from "@agent-desk/scheduler";
import {
  buildDaemonEnv,
  refreshSandboxConnections,
  resolveLocalSourceEnv,
} from "@agent-desk/runtime";
import { generateId, type WsEvent } from "@agent-desk/shared";
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

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-connref-api-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "connref-api";
  process.env.DESK_SEED_PASSWORD = "connref-pass";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-connref-api-home-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;
  const { rows: userRows } = await pool.query<{ id: string }>("SELECT id FROM users LIMIT 1");
  userId = userRows[0].id;
  vault = new VaultStore(path.join(home, "vaults"));
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
      await refreshSandboxConnections({
        pool,
        userId: uid,
        workspaceId: wsId,
        buildSandboxEnv: async (innerUid, innerWsId) => {
          const providerKeys = await resolveProviderKeys(pool, vault, innerUid, innerWsId);
          const extraEnv = await resolveLocalSourceEnv(pool, innerUid);
          return buildDaemonEnv({ providerKeys, extraEnv });
        },
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  // Login + create a workspace + chat with a stamped opencode session id.
  const login = await request("POST", "/auth/login", undefined, {
    username: "connref-api", password: "connref-pass",
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
  await queries.chats.setOpencodeSessionId(pool, chatId, sessionId);
  return chatId;
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
  it("clears the user's opencode sessions when a connection is created", async () => {
    const chatId = await makeChatWithSession("ses_create_before");
    expect(await queries.chats.getOpencodeSessionId(pool, chatId)).toBe("ses_create_before");

    const created = await request("POST", "/me/connections", token, {
      providerId: "github",
      displayName: "GH for refresh",
      credentials: { token: "ghp_test_create" },
    });
    expect(created.status).toBe(201);

    expect(await queries.chats.getOpencodeSessionId(pool, chatId)).toBeNull();
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

    expect(await queries.chats.getOpencodeSessionId(pool, chatId)).toBeNull();
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

    expect(await queries.chats.getOpencodeSessionId(pool, chatId)).toBeNull();
  });

  it("clears sessions when a local source is toggled off", async () => {
    // Enable codex first so we have a state to flip.
    await request("PUT", "/me/providers/local/codex", token, { enabled: true });
    const chatId = await makeChatWithSession("ses_codex_before");

    const toggled = await request("PUT", "/me/providers/local/codex", token, { enabled: false });
    expect(toggled.status).toBe(200);

    expect(await queries.chats.getOpencodeSessionId(pool, chatId)).toBeNull();
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
    await queries.chats.setOpencodeSessionId(pool, chatInTarget, "ses_target");
    await queries.chats.setOpencodeSessionId(pool, chatInOther, "ses_other");

    // Need a connection to grant.
    const conn = await request("POST", "/me/connections", token, {
      providerId: "slack",
      displayName: "Slack for grant",
      credentials: { token: "xoxb" },
    });
    const connId = conn.body.connection.id;
    // Connection creation already cleared sessions; reseed both before testing the grant call.
    await queries.chats.setOpencodeSessionId(pool, chatInTarget, "ses_target_again");
    await queries.chats.setOpencodeSessionId(pool, chatInOther, "ses_other_again");

    const grants = await request("PUT", `/workspaces/${workspaceId}/connections`, token, {
      grants: [
        { connectionId: connId, providerId: "slack", grantedCapabilities: [], isDefault: true },
      ],
    });
    expect(grants.status).toBe(200);

    expect(await queries.chats.getOpencodeSessionId(pool, chatInTarget)).toBeNull();
    expect(await queries.chats.getOpencodeSessionId(pool, chatInOther)).toBe("ses_other_again");
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
 * never reached opencode-serve.
 *
 * These tests cover both halves of the fix:
 *   - PUT /me/providers writes the token in a shape resolveProviderKeys
 *     actually finds, and emits both the canonical env var and the
 *     managed-alias env var when wrapped by buildDaemonEnv.
 *   - PUT /me/providers (and /me/providers/meta) triggers the same
 *     refresh wiring as POST /me/connections (session clear + WS
 *     broadcast).
 */
describe("legacy /me/providers — sandbox env propagation", () => {
  it("makes GITHUB_TOKEN visible to resolveProviderKeys after PUT /me/providers", async () => {
    const put = await request("PUT", "/me/providers", token, {
      providers: { GITHUB_TOKEN: "ghp_legacy_resolves" },
    });
    expect(put.status).toBe(200);

    const resolved = await resolveProviderKeys(pool, vault, userId, workspaceId);
    expect(resolved.GITHUB_TOKEN).toBe("ghp_legacy_resolves");
  });

  it("buildDaemonEnv mirrors GITHUB_TOKEN to the GH_TOKEN alias the GitHub CLI reads", async () => {
    await request("PUT", "/me/providers", token, {
      providers: { GITHUB_TOKEN: "ghp_alias_value" },
    });

    const providerKeys = await resolveProviderKeys(pool, vault, userId, workspaceId);
    const env = buildDaemonEnv({ providerKeys });
    expect(env.GITHUB_TOKEN).toBe("ghp_alias_value");
    expect(env.GH_TOKEN).toBe("ghp_alias_value");
  });

  it("clears sessions and broadcasts when PUT /me/providers saves a key", async () => {
    const chatId = await makeChatWithSession("ses_put_providers");
    const ws = new CapturingWs();
    addConnection(userId, ws);

    const put = await request("PUT", "/me/providers", token, {
      providers: { GITHUB_TOKEN: "ghp_triggers_refresh" },
    });
    expect(put.status).toBe(200);

    expect(await queries.chats.getOpencodeSessionId(pool, chatId)).toBeNull();
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

    expect(await queries.chats.getOpencodeSessionId(pool, chatId)).toBeNull();

    // Disabled providers must not appear in the resolved env — otherwise
    // the Settings toggle is purely cosmetic and the daemon still sees
    // the key.
    const resolved = await resolveProviderKeys(pool, vault, userId, workspaceId);
    expect(resolved.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
