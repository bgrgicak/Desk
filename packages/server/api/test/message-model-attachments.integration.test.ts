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
import { Pool } from "@desk/db";
import { runMigrations, seedIfEmpty, queries } from "@desk/db";
import { ensureLayout } from "@desk/storage";
import { createRunManager } from "@desk/scheduler";
import { generateId } from "@desk/shared";
import { createApp } from "../src/app.js";
import { clearSessions } from "../src/auth/sessions.js";
import { clearConnections } from "../src/ws/registry.js";

let pool: Pool;
let server: http.Server;
let port: number;
let home: string;
let userToken: string;
let chatId: string;
let agentModel: string;
let runManager: ReturnType<typeof createRunManager>;
let dbPath: string;
/** Captures the prompt + forwarded attachments seen by the fake driver on each fireMessage call. */
const promptsSeen: { prompt: string; attachments?: string[] }[] = [];

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-msg-attach-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  process.env.DESK_SEED_USERNAME = "attach-user";
  process.env.DESK_SEED_PASSWORD = "pw";
  process.env.DESK_SANDBOX_DRIVER = "fake";
  await seedIfEmpty(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-msg-attach-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;

  runManager = createRunManager({
    pool,
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
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
    [chatId, wsRows[0].id, agentRows[0].id, "Attach Chat"],
  );

  server = createApp({ pool, storage: { pool, home }, runManager, broadcastUserId });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;

  // Log in once; reuse the token for user-authed requests.
  userToken = await login();
});

afterAll(async () => {
  await clearSessions(pool);
  clearConnections();
  server?.close();
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DESK_HOME;
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
  const { rows } = await pool.query(
    `SELECT id FROM messages
     WHERE chat_id = ? AND role = 'system' AND json_extract(content, '$.type') = 'agent_turn'
       AND json_extract(content, '$.userMessageId') = ?
     ORDER BY created_at DESC LIMIT 1`,
    [chatId, messageId],
  );
  const triggerId = rows[0]?.id as string;
  expect(triggerId).toBeDefined();
  await runManager.fireMessage(triggerId);
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

describe("GET /library/content for chat attachments", () => {
  // The chat-attachment path lives under `.chats/<chatId>/attachments/<file>`.
  // The library read endpoints (used by the in-app file detail view) need to
  // accept that shape so clicking an attachment chip can open the same
  // ContextDetail UI as a library file. Other dot-prefixed paths must stay
  // blocked so this isn't a backdoor into agent infrastructure.
  const filename = "open-me.txt";
  const fileBody = "attachment open-in-library content";
  let attachmentPath: string;

  beforeAll(async () => {
    attachmentPath = `.chats/${chatId}/attachments/${filename}`;
    const dir = path.join(home, "Desk", "workspaces", "desk", ".chats", chatId, "attachments");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), fileBody);
  });

  it("serves a chat-owned attachment file as inline content", async () => {
    const res = await fetchPath(`/library/content?path=${encodeURIComponent(attachmentPath)}`, userToken);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe(fileBody);
    expect(res.headers["content-disposition"]).toMatch(/^inline/);
  });

  it("returns metadata for a chat-owned attachment via /library/meta", async () => {
    const res = await request(
      "GET",
      `/library/meta?path=${encodeURIComponent(attachmentPath)}`,
      undefined,
      userToken,
    );
    expect(res.status).toBe(200);
    const meta = res.body as { path: string; name: string; size: number };
    expect(meta.path).toBe(attachmentPath);
    expect(meta.name).toBe(filename);
    expect(meta.size).toBe(fileBody.length);
  });

  it("serves a chat-owned note via /library/meta with a 'Chat notes' label", async () => {
    const noteFilename = "msg_open_me.md";
    const notePath = `.chats/${chatId}/notes/${noteFilename}`;
    const noteDir = path.join(home, "Desk", "workspaces", "desk", ".chats", chatId, "notes");
    await fs.mkdir(noteDir, { recursive: true });
    await fs.writeFile(path.join(noteDir, noteFilename), "# Running summary\n");

    const noteRes = await request(
      "GET",
      `/library/meta?path=${encodeURIComponent(notePath)}`,
      undefined,
      userToken,
    );
    expect(noteRes.status).toBe(200);
    const meta = noteRes.body as { path: string; name: string; label?: string };
    expect(meta.path).toBe(notePath);
    expect(meta.name).toBe(noteFilename);
    expect(meta.label).toBe("Chat notes");
  });

  it("still rejects other dot-prefixed paths (e.g. .chats/<id>/logs/) with 404", async () => {
    const logRes = await request(
      "GET",
      `/library/meta?path=${encodeURIComponent(`.chats/${chatId}/logs/anything.log`)}`,
      undefined,
      userToken,
    );
    expect(logRes.status).toBe(404);
  });
});

async function fetchPath(
  urlPath: string,
  bearer: string,
): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "GET",
        headers: { Authorization: `Bearer ${bearer}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

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
       WHERE chat_id = ? AND role = 'agent' AND parent_id IS NOT NULL
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
       VALUES (?, ?, 'system', ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour'))`,
      [requestId, chatId, JSON.stringify({ type: "ai_note_request" })],
    );
    const { childIds } = await runManager.fireMessage(requestId);
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
       VALUES (?, ?, 'system', ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour'))`,
      [reqId, chatId, JSON.stringify({ type: "ai_note_request" })],
    );
    const { childIds } = await runManager.fireMessage(reqId);
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
