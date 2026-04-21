import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import pg from "pg";
import { runMigrations, seedIfEmpty } from "@desk/db";
import { generateId } from "@desk/shared";
import { ensureLayout } from "@desk/storage";
import { issueSessionToken } from "../../src/auth.js";
import { createToolServer } from "../../src/server.js";
import type { StorageContext } from "@desk/storage";
import type { WsEvent } from "@desk/shared";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_tools_test_${workerId}`;

function baseUrl(): string {
  return process.env.DESK_TEST_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? "postgresql://desk:desk@127.0.0.1:55432/desk";
}

function adminConnectionString(): string {
  const url = new URL(baseUrl());
  url.pathname = "/postgres";
  return url.toString();
}

function testConnectionString(): string {
  const url = new URL(baseUrl());
  url.pathname = `/${testDbName}`;
  return url.toString();
}

function adminPool(): pg.Pool {
  return new pg.Pool({ connectionString: adminConnectionString() });
}

export interface TestToolContext {
  pool: pg.Pool;
  home: string;
  server: http.Server;
  port: number;
  workspaceId: string;
  agentId: string;
  chatId: string;
  token: string;
  sessionId: string;
  events: WsEvent[];
}

export async function setupTestTools(): Promise<TestToolContext> {
  const admin = adminPool();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await admin.query(`CREATE DATABASE ${testDbName}`);
  } finally {
    await admin.end();
  }

  const pool = new pg.Pool({ connectionString: testConnectionString() });

  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  } catch { /* ok */ }

  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "testuser";
  process.env.DESK_SEED_PASSWORD = "testpass";
  await seedIfEmpty(pool);

  const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
  const workspaceId = wsRows[0].id as string;

  const { rows: agentRows } = await pool.query("SELECT id FROM agents LIMIT 1");
  const agentId = agentRows[0].id as string;

  const chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES ($1, $2, $3, $4)`,
    [chatId, workspaceId, agentId, "Test Chat"],
  );

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-tools-test-"));
  await ensureLayout(home);

  const storage: StorageContext = { pool, home };

  const events: WsEvent[] = [];
  const server = createToolServer({
    pool,
    storage,
    onEvent: (evt) => events.push(evt),
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address() as { port: number };

  const { token, session } = await issueSessionToken(pool, agentId);

  return {
    pool,
    home,
    server,
    port: address.port,
    workspaceId,
    agentId,
    chatId,
    token,
    sessionId: session.id,
    events,
  };
}

export async function teardownTestTools(ctx: TestToolContext): Promise<void> {
  if (!ctx) return;

  await new Promise<void>((resolve) => {
    ctx.server.close(() => resolve());
  });

  await ctx.pool.end();
  await fs.rm(ctx.home, { recursive: true, force: true });

  const admin = adminPool();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
  } finally {
    await admin.end();
  }
}

export function toolRequest(
  ctx: TestToolContext,
  toolName: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: ctx.port,
        path: `/tools/${toolName}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          "X-Desk-Sandbox-Token": ctx.token,
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode!, body: raw });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
