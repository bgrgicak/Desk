/**
 * Integration tests for goal persistence on `POST /chats/:id/messages`.
 *
 * Real Postgres (well, real SQLite via the same Pool harness used by the
 * chat-delete test). Exercises both the JSON path (`sendMessage`) and
 * the streaming multipart path since both have to
 * write to `chats.goal` for the column to be the source of truth used
 * by the scheduler in Task 4.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { Pool, runMigrations, queries, hashPassword } from "@roomy-ai/db";
import { ensureLayout, type StorageContext } from "@roomy-ai/storage";
import { generateId } from "@roomy-ai/shared";
import {
  buildSendMessageBodyFromMultipartRequest,
  sendMessage,
} from "../src/routes/chats.js";

let pool: Pool;
let home: string;
let dbPath: string;
let userId: string;
let workspaceId: string;
let workspaceSlug: string;
let agentId: string;
let storage: StorageContext;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-chat-goals-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-chat-goals-"));
  await ensureLayout(home);
  process.env.ROOMY_HOME = home;
  storage = { pool, home };

  userId = generateId("user");
  await queries.users.insert(pool, {
    id: userId,
    username: "goals_user",
    passwordHash: await hashPassword("pw"),
    email: "goals@example.com",
  });

  const workspace = await queries.workspaces.insert(pool, {
    id: generateId("workspace"),
    userId,
    name: "ws-goals",
    description: "",
    icon: "",
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.path;

  await fs.mkdir(path.join(home, workspaceSlug), { recursive: true });

  agentId = generateId("agent");
  await queries.agents.insert(pool, {
    id: agentId,
    userId,
    name: "agent-goals",
    model: "anthropic/claude-haiku-4-5",
  });
  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`,
    [workspaceId, agentId],
  );
});

afterAll(async () => {
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.ROOMY_HOME;
});

async function freshChat(): Promise<string> {
  const chatId = generateId("chat");
  await queries.chats.insert(pool, {
    id: chatId,
    workspaceId,
    agentId,
    title: "goal test",
  });
  return chatId;
}

async function multipartRequestFromForm(form: FormData): Promise<IncomingMessage> {
  const request = new Request("http://localhost/chats/test/messages", {
    method: "POST",
    body: form,
  });
  const req = Readable.from(Buffer.from(await request.arrayBuffer())) as IncomingMessage & {
    headers: IncomingHttpHeaders;
  };
  req.headers = Object.fromEntries(request.headers.entries());
  return req;
}

describe("goal persistence on send", () => {
  it("JSON path: send with goal sets chats.goal", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "build me a doc", goal: "document" },
      () => {},
    );
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBe("document");
  });

  it("JSON path: task send with goal sets chats.goal", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "finish this", kind: "task", goal: "task" },
      () => {},
    );
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBe("task");
  });

  it("JSON path: invalid explicit goal is rejected", async () => {
    const chatId = await freshChat();
    await expect(sendMessage(
      pool,
      chatId,
      { content: "hello", goal: "not-a-goal" },
      () => {},
    )).rejects.toThrow(/Invalid chat goal/);
  });

  it("JSON path: send without goal leaves chats.goal empty", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "let's build a calendar app" },
      () => {},
    );
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBeUndefined();
  });

  it("JSON path: send without a matching goal leaves chats.goal empty", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "hello" },
      () => {},
    );
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBeUndefined();
  });

  it("JSON path: agent-role send without goal does not set chats.goal", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "build a dashboard", kind: "task" },
      () => {},
      { role: "agent" },
    );
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBeUndefined();
  });

  it("JSON path: subsequent send without goal does not overwrite the column", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "first", goal: "document" },
      () => {},
    );
    await sendMessage(
      pool,
      chatId,
      { content: "second" },
      () => {},
    );
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBe("document");
  });

  it("JSON path: explicit null goal clears chats.goal", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "first", goal: "document" },
      () => {},
    );
    await sendMessage(
      pool,
      chatId,
      { content: "build me an app", goal: null },
      () => {},
    );
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBeUndefined();
  });

  it("JSON path: message content does not embed the goal", async () => {
    const chatId = await freshChat();
    const { userMessage } = await sendMessage(
      pool,
      chatId,
      { content: "hello", goal: "image" },
      () => {},
    );
    // The goal lives on chats.goal, not in the message body.
    expect(userMessage.content).toEqual({ type: "text", text: "hello" });
  });

  it("multipart path: form fields with goal are propagated and persisted", async () => {
    const chatId = await freshChat();
    const form = new FormData();
    form.set("content", "via multipart");
    form.set("goal", "data");

    const body = await buildSendMessageBodyFromMultipartRequest(storage, chatId, await multipartRequestFromForm(form));
    expect(body).toMatchObject({ content: "via multipart", goal: "data" });

    await sendMessage(pool, chatId, body, () => {});
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBe("data");
  });

  it("multipart path: streams file uploads and keeps fields that arrive after file parts", async () => {
    const chatId = await freshChat();
    const form = new FormData();
    form.set("content", "with upload");
    form.set("attachments", JSON.stringify([{ path: "notes/source.md", name: "source.md" }]));
    form.append("attachment", new Blob(["streamed body"], { type: "text/plain" }), "upload.txt");
    form.set("kind", "task");
    form.set("goal", "data");

    const body = await buildSendMessageBodyFromMultipartRequest(storage, chatId, await multipartRequestFromForm(form));
    expect(body).toMatchObject({
      content: "with upload",
      kind: "task",
      goal: "data",
    });
    const attachments = (body as { attachments?: Array<{ path: string; name: string; mime?: string; size?: number }> }).attachments;
    expect(attachments).toHaveLength(2);
    expect(attachments?.[0]).toMatchObject({ path: "notes/source.md", name: "source.md" });
    expect(attachments?.[1]).toMatchObject({
      path: `.chats/${chatId}/attachments/upload.txt`,
      name: "upload.txt",
      mime: "text/plain",
      size: "streamed body".length,
    });
    await expect(fs.readFile(path.join(home, workspaceSlug, attachments?.[1]?.path ?? ""), "utf8"))
      .resolves.toBe("streamed body");
  });

  it("multipart path: form without goal leaves chats.goal empty", async () => {
    const chatId = await freshChat();
    const form = new FormData();
    form.set("content", "show me a portfolio site");

    const body = await buildSendMessageBodyFromMultipartRequest(storage, chatId, await multipartRequestFromForm(form));
    expect(body).toMatchObject({ content: "show me a portfolio site" });

    await sendMessage(pool, chatId, body, () => {});
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBeUndefined();
  });

  it("multipart path: empty goal field clears chats.goal", async () => {
    const chatId = await freshChat();
    await sendMessage(
      pool,
      chatId,
      { content: "first", goal: "document" },
      () => {},
    );
    const form = new FormData();
    form.set("content", "build me an app");
    form.set("goal", "");

    const body = await buildSendMessageBodyFromMultipartRequest(storage, chatId, await multipartRequestFromForm(form));
    expect(body).toMatchObject({ content: "build me an app", goal: null });

    await sendMessage(pool, chatId, body, () => {});
    const chat = await queries.chats.findById(pool, chatId);
    expect(chat?.goal).toBeUndefined();
  });
});
