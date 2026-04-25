/**
 * Integration test for per-message `attachments` + `model` stamping and
 * notes/{id}.md materialization. Real Postgres, real filesystem, fake
 * sandbox driver (no Docker).
 *
 * Covers:
 *   - POST /chats/{id}/messages with an attachments[] body persists them on
 *     the user message row (envelope field, not content).
 *   - fireMessage includes the attachment filename in the agent prompt so
 *     the model knows what the user sent alongside their text.
 *   - fireMessage stamps the agent's configured model on the inserted
 *     assistant row, so historical bubbles render the correct label even
 *     if the agent is later reconfigured.
 *   - ai_note_request firing materializes the produced note body at
 *     `~/.chats/{chatId}/notes/{messageId}.md` so the agent can read its
 *     own notes with ordinary file tools.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { ensureLayout } from "@desk/storage";
import { createMemoryAdapter, createRunManager } from "@desk/scheduler";
import { generateId } from "@desk/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";
import { resetInternalTokenCache } from "../src/auth/internal.js";

const workerId = process.env.VITEST_WORKER_ID ?? "0";
const testDbName = `desk_msg_model_attachments_${workerId}`;

function adminConn(): string {
  const url = new URL(process.env.DESK_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://desk:desk@127.0.0.1:55432/desk");
  url.pathname = "/postgres";
  return url.toString();
}
function testConn(): string {
  const url = new URL(process.env.DESK_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://desk:desk@127.0.0.1:55432/desk");
  url.pathname = `/${testDbName}`;
  return url.toString();
}

let pool: pg.Pool;
let server: http.Server;
let port: number;
let home: string;
let userToken: string;
let internalToken: string;
let chatId: string;
let agentModel: string;
/** Captures the prompt + forwarded attachments seen by the fake driver on each fireMessage call. */
const promptsSeen: { prompt: string; attachments?: string[] }[] = [];

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: adminConn() });
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [testDbName]);
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
    await admin.query(`CREATE DATABASE ${testDbName}`);
  } finally { await admin.end(); }

  pool = new pg.Pool({ connectionString: testConn() });
  try { await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm"); } catch { /* ok */ }
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "attach-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  process.env.DESK_SANDBOX_DRIVER = "fake";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-msg-attach-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  const tokenPath = path.join(home, "internal-token");
  internalToken = "internaltoken123456789012345678901";
  await fs.writeFile(tokenPath, internalToken, { mode: 0o600 });
  process.env.DESK_INTERNAL_TOKEN_PATH = tokenPath;
  resetInternalTokenCache();

  const runManager = createRunManager({
    pool,
    adapter: createMemoryAdapter(),
    execRunFn: async (runId, _a, prompt, onLog, runOpts) => {
      promptsSeen.push({ prompt, attachments: runOpts?.attachments });
      onLog({ runId, seq: 0, kind: "stdout", payload: "## Summary\n\nThe chat discussed the attached file." });
      return { exitCode: 0 };
    },
  });

  const { rows: userRows } = await pool.query("SELECT id FROM users LIMIT 1");
  const broadcastUserId = userRows[0].id as string;

  const { rows: wsRows } = await pool.query("SELECT id FROM workspaces LIMIT 1");
  const { rows: agentRows } = await pool.query("SELECT id, model FROM agents LIMIT 1");
  agentModel = agentRows[0].model as string;
  chatId = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES ($1, $2, $3, $4)`,
    [chatId, wsRows[0].id, agentRows[0].id, "Attach Chat"],
  );

  server = createApp({ pool, storage: { pool, home }, runManager, broadcastUserId });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  // Log in once; reuse the token for user-authed requests.
  userToken = await login();
});

afterAll(async () => {
  clearSessions();
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  resetInternalTokenCache();
  delete process.env.DESK_INTERNAL_TOKEN_PATH;
  delete process.env.DESK_HOME;

  const admin = new pg.Pool({ connectionString: adminConn() });
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [testDbName]);
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName}`);
  } finally { await admin.end(); }
});

function request(method: string, urlPath: string, body?: unknown, bearer?: string | null): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));
    const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function login(): Promise<string> {
  const res = await request("POST", "/auth/login", { username: "attach-user", password: "pw" });
  return (res.body as { token: string }).token;
}

async function fireTriggerFor(messageId: string): Promise<void> {
  // Walk the chat to find the newest agent_turn trigger for this user message.
  const { rows } = await pool.query(
    `SELECT id FROM messages
     WHERE chat_id = $1 AND role = 'system' AND content->>'type' = 'agent_turn'
       AND content->>'userMessageId' = $2
     ORDER BY created_at DESC LIMIT 1`,
    [chatId, messageId],
  );
  const triggerId = rows[0]?.id as string;
  expect(triggerId).toBeDefined();
  const res = await request("POST", "/internal/messages/fire", { messageId: triggerId }, internalToken);
  expect(res.status).toBe(200);
}

describe("POST /chats/{id}/messages with attachments", () => {
  it("persists attachments on the user message envelope", async () => {
    const res = await request(
      "POST",
      `/chats/${chatId}/messages`,
      {
        content: "please review the attached spec",
        attachments: [
          { path: `.chats/${chatId}/attachments/spec.md`, name: "spec.md", mime: "text/markdown", size: 1024 },
        ],
      },
      userToken,
    );
    expect(res.status).toBe(201);
    const body = res.body as { id: string; attachments?: unknown };
    expect(Array.isArray(body.attachments)).toBe(true);
    const row = await queries.messages.findById(pool, body.id);
    expect(row?.attachments).toEqual([
      { path: `.chats/${chatId}/attachments/spec.md`, name: "spec.md", mime: "text/markdown", size: 1024 },
    ]);
  });

  it("forwards attachment paths to the runtime so opencode receives them as --file flags", async () => {
    promptsSeen.length = 0;
    const res = await request(
      "POST",
      `/chats/${chatId}/messages`,
      {
        content: "what does this file say?",
        attachments: [{ path: `.chats/${chatId}/attachments/notes.txt`, name: "notes.txt" }],
      },
      userToken,
    );
    expect(res.status).toBe(201);

    // POST triggers an async fireMessage; wait for the driver to see THIS
    // test's prompt specifically — prior tests' fire-and-forget fires can
    // land in promptsSeen mid-test, so match on content, not length.
    const deadline = Date.now() + 5000;
    while (!promptsSeen.some((p) => p.prompt.includes("what does this file say?")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const seen = promptsSeen.find((p) => p.prompt.includes("what does this file say?"));
    expect(seen).toBeDefined();
    // The prompt is just the user's text — paths are no longer inlined.
    expect(seen!.prompt).not.toContain("attachments/notes.txt");
    // The workspace-relative path is forwarded as-is; the runtime translates
    // it to a sandbox-absolute path when building the opencode command.
    expect(seen!.attachments).toEqual([`.chats/${chatId}/attachments/notes.txt`]);
  });

  it("forwards a directory attachment as a workspace-relative path so opencode receives it via --file", async () => {
    // Folders ride the same AttachmentRef wire as files; opencode's `--file`
    // flag accepts directory paths and lists contents to the model. The path
    // has no extension and points at a folder under the workspace root.
    promptsSeen.length = 0;
    const folderPath = "Photos/2024";
    const res = await request(
      "POST",
      `/chats/${chatId}/messages`,
      {
        content: "summarise the photos in this folder",
        attachments: [{ path: folderPath, name: "2024", kind: "directory" }],
      },
      userToken,
    );
    expect(res.status).toBe(201);

    const deadline = Date.now() + 5000;
    while (
      !promptsSeen.some((p) => p.prompt.includes("summarise the photos in this folder")) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const seen = promptsSeen.find((p) =>
      p.prompt.includes("summarise the photos in this folder"),
    );
    expect(seen).toBeDefined();
    expect(seen!.attachments).toEqual([folderPath]);

    // Round-trip the persisted row to confirm the directory survived the
    // wire — including the `kind` discriminator the UI relies on for
    // icon + click-handler routing.
    const body = res.body as { id: string };
    const row = await queries.messages.findById(pool, body.id);
    expect(row?.attachments).toEqual([
      { path: folderPath, name: "2024", kind: "directory" },
    ]);
  });

  it("rejects attachments[] with a bad shape (negative size)", async () => {
    const res = await request(
      "POST",
      `/chats/${chatId}/messages`,
      {
        content: "x",
        attachments: [{ path: "p", name: "p", size: -1 }],
      },
      userToken,
    );
    expect(res.status).toBe(400);
  });
});

describe("fireMessage stamps model on the assistant row", () => {
  it("the child message carries the agent's configured model", async () => {
    const res = await request(
      "POST",
      `/chats/${chatId}/messages`,
      { content: "stamp the model please" },
      userToken,
    );
    expect(res.status).toBe(201);
    const userId = (res.body as { id: string }).id;
    await fireTriggerFor(userId);

    const { rows } = await pool.query(
      `SELECT id, model FROM messages
       WHERE chat_id = $1 AND role = 'agent' AND parent_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [chatId],
    );
    expect(rows[0]?.model).toBe(agentModel);

    const row = await queries.messages.findById(pool, rows[0].id as string);
    expect(row?.model).toBe(agentModel);
  });
});

describe("notes/{id}.md is materialized when ai_note_request fires", () => {
  it("writes the note body to ~/.chats/{chatId}/notes/{messageId}.md", async () => {
    // Seed a pending ai_note_request and fire it.
    const requestId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at)
       VALUES ($1, $2, 'system', $3, 'pending', now() + interval '1 hour')`,
      [requestId, chatId, JSON.stringify({ type: "ai_note_request" })],
    );
    const fire = await request("POST", "/internal/messages/fire", { messageId: requestId }, internalToken);
    expect(fire.status).toBe(200);
    const { childIds } = fire.body as { childIds: string[] };
    expect(childIds.length).toBe(1);

    const notePath = path.join(home, "Desk", "workspaces", "desk", ".chats", chatId, "notes", `${childIds[0]}.md`);
    const content = await fs.readFile(notePath, "utf-8");
    expect(content).toContain("Summary");
    expect(content).toContain("attached file");
  });

  it("re-materializes on PATCH when the user edits the note body", async () => {
    // Produce a fresh note first.
    const reqId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, state, execute_at)
       VALUES ($1, $2, 'system', $3, 'pending', now() + interval '1 hour')`,
      [reqId, chatId, JSON.stringify({ type: "ai_note_request" })],
    );
    const fire = await request("POST", "/internal/messages/fire", { messageId: reqId }, internalToken);
    const { childIds } = fire.body as { childIds: string[] };
    const noteId = childIds[0];

    const patched = await request(
      "PATCH",
      `/chats/${chatId}/messages/${noteId}`,
      { content: { type: "note", body: "User-edited summary of the chat." } },
      userToken,
    );
    expect(patched.status).toBe(200);

    const notePath = path.join(home, "Desk", "workspaces", "desk", ".chats", chatId, "notes", `${noteId}.md`);
    const content = await fs.readFile(notePath, "utf-8");
    expect(content).toBe("User-edited summary of the chat.");
  });
});
