import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@roomy-ai/db";
import { runMigrations, queries } from "@roomy-ai/db";
import { generateId } from "@roomy-ai/shared";
import {
  createRunManager,
  runDailyReflection,
  runWorkspaceReflection,
  ensureDailyReflectionTasks,
  yesterdayDateLocal,
  type ReflectFn,
  type WorkspaceReflectionInput,
} from "../src/index.js";

let pool: Pool;
let home: string;
let dbPath: string;
let userId: string;
let agentId: string;
let workspaceAId: string;
let workspaceASlug: string;
let workspaceBId: string;
let workspaceBSlug: string;

const REFLECTION_DATE = "2026-05-05";

async function createMessage(chatId: string, role: "user" | "agent", text: string, createdAt: string): Promise<void> {
  await pool.query(
    `INSERT INTO messages (id, chat_id, role, content, kind, created_at)
     VALUES (?, ?, ?, ?, 'chat', ?)`,
    [generateId("message"), chatId, role, JSON.stringify({ type: "text", text }), createdAt],
  );
}

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-reflection-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-reflection-"));

  userId = generateId("user");
  await pool.query(
    `INSERT INTO users (id, username, password_hash, email)
     VALUES (?, 'reflector', 'hash', 'reflect@example.com')`,
    [userId],
  );
  agentId = generateId("agent");
  await pool.query(
    `INSERT INTO agents (id, user_id, name, model)
     VALUES (?, ?, ?, 'anthropic/claude-haiku-4-5')`,
    [agentId, userId, "Reflector"],
  );

  workspaceAId = generateId("workspace");
  workspaceASlug = `reflect-a-${workspaceAId.slice(-6)}`;
  workspaceBId = generateId("workspace");
  workspaceBSlug = `reflect-b-${workspaceBId.slice(-6)}`;
  await pool.query(
    `INSERT INTO workspaces (id, user_id, name, path) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
    [
      workspaceAId, userId, "WS A", workspaceASlug,
      workspaceBId, userId, "WS B", workspaceBSlug,
    ],
  );
  await queries.workspaceAgents.addToWorkspace(pool, workspaceAId, agentId);
  await queries.workspaceAgents.addToWorkspace(pool, workspaceBId, agentId);

  // Seed yesterday's activity in workspace A only.
  const chatA = generateId("chat");
  await pool.query(
    `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
    [chatA, workspaceAId, agentId, "WS A Chat"],
  );
  await createMessage(chatA, "user", "Set up the kanban board.", `${REFLECTION_DATE}T10:00:00.000Z`);
  await createMessage(chatA, "agent", "Sure — added todo, doing, done.", `${REFLECTION_DATE}T10:01:00.000Z`);
  await createMessage(chatA, "user", "Move the Q2 review onto the board.", `${REFLECTION_DATE}T11:00:00.000Z`);

  // No activity for workspace B.
});

afterAll(async () => {
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
});

describe("yesterdayDateLocal", () => {
  it("formats yesterday in server local time as YYYY-MM-DD", () => {
    // Reference: noon local on the date we expect "yesterday" to be
    // computed from. Picking 12:00 avoids the cross-midnight DST/UTC
    // skew the UTC implementation suffered from when the cron fired
    // at server-local 03:00.
    const noon = new Date(2026, 4, 6, 12, 0, 0); // 2026-05-06 12:00 local
    expect(yesterdayDateLocal(noon)).toBe("2026-05-05");
  });
});

describe("runWorkspaceReflection", () => {
  beforeEach(async () => {
    await fs.rm(path.join(home, workspaceASlug, ".memory"), {
      recursive: true,
      force: true,
    });
  });

  it("writes a journal entry and applies memory edits when there's activity", async () => {
    const reflectWorkspace: ReflectFn<WorkspaceReflectionInput> = async (input) => {
      expect(input.date).toBe(REFLECTION_DATE);
      expect(input.activity.length).toBeGreaterThan(0);
      expect(input.activity[0].body).toContain("kanban");
      return {
        journal: `# Journal — ${input.date}\n\nUser set up the kanban board in ${input.workspaceName}.`,
        memoryEdits: [
          { path: "kanban-prefs.md", body: "# Kanban prefs\n\n- columns: todo, doing, done\n" },
        ],
      };
    };
    const body = await runWorkspaceReflection({
      pool,
      home,
      date: REFLECTION_DATE,
      workspaceId: workspaceAId,
      workspaceSlug: workspaceASlug,
      workspaceName: "WS A",
      userId,
      userName: "reflector",
      agent: { id: agentId, name: "Reflector", model: "anthropic/claude-haiku-4-5" },
      reflectWorkspace,
    });

    expect(body).toContain("kanban board");

    const journalPath = path.join(
      home,
      workspaceASlug,
      ".memory",
      "journal",
      `${REFLECTION_DATE}.md`,
    );
    const journal = await fs.readFile(journalPath, "utf-8");
    expect(journal).toContain(REFLECTION_DATE);

    const editPath = path.join(
      home,
      workspaceASlug,
      ".memory",
      "kanban-prefs.md",
    );
    const edit = await fs.readFile(editPath, "utf-8");
    expect(edit).toContain("Kanban prefs");
  });

  it("passes the last 30 prior workspace journals for memory curation", async () => {
    const journalDir = path.join(
      home,
      workspaceASlug,
      ".memory",
      "journal",
    );
    await fs.mkdir(journalDir, { recursive: true });
    const firstJournal = Date.UTC(2026, 3, 4); // 2026-04-04
    for (let offset = 0; offset < 31; offset++) {
      const journalDate = new Date(firstJournal + offset * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      await fs.writeFile(
        path.join(journalDir, `${journalDate}.md`),
        `# Journal ${journalDate}\n\nWorked on item ${offset + 1}.`,
        "utf-8",
      );
    }
    await fs.writeFile(
      path.join(journalDir, `${REFLECTION_DATE}.md`),
      "# Existing same-day journal should not be input",
      "utf-8",
    );
    await fs.writeFile(path.join(journalDir, "not-a-journal.txt"), "ignored", "utf-8");

    const reflectWorkspace: ReflectFn<WorkspaceReflectionInput> = async (input) => {
      expect(input.priorJournals).toHaveLength(30);
      expect(input.priorJournals[0]).toEqual({
        date: "2026-05-04",
        body: "# Journal 2026-05-04\n\nWorked on item 31.",
      });
      expect(input.priorJournals.at(-1)?.date).toBe("2026-04-05");
      expect(input.priorJournals.map((j) => j.date)).not.toContain("2026-04-04");
      expect(input.priorJournals.map((j) => j.date)).not.toContain(REFLECTION_DATE);
      return { journal: "# Journal\n" };
    };

    await runWorkspaceReflection({
      pool,
      home,
      date: REFLECTION_DATE,
      workspaceId: workspaceAId,
      workspaceSlug: workspaceASlug,
      workspaceName: "WS A",
      userId,
      userName: "reflector",
      agent: { id: agentId, name: "Reflector", model: "anthropic/claude-haiku-4-5" },
      reflectWorkspace,
    });
  });

  it("includes 👍 / 👎 feedback system messages in workspace activity", async () => {
    // Reactions left via the thumbs buttons in the chat are persisted as
    // `role: 'system'` messages with `feedback` content. The daily
    // reflection should see them rendered as readable lines alongside
    // the surrounding conversation, so the prompt can use them as
    // explicit user verdicts on prior replies.
    //
    // The test creates a self-contained workspace + chat and tears them
    // down at the end so downstream `runDailyReflection` assertions
    // about which workspaces had activity stay deterministic.
    const wsId = generateId("workspace");
    const wsSlug = `reflect-feedback-${wsId.slice(-6)}`;
    await pool.query(
      `INSERT INTO workspaces (id, user_id, name, path) VALUES (?, ?, ?, ?)`,
      [wsId, userId, "WS Feedback", wsSlug],
    );
    await queries.workspaceAgents.addToWorkspace(pool, wsId, agentId);
    const chatId = generateId("chat");
    await pool.query(
      `INSERT INTO chats (id, workspace_id, agent_id, title) VALUES (?, ?, ?, ?)`,
      [chatId, wsId, agentId, "Feedback Chat"],
    );
    try {
      await createMessage(chatId, "agent", "Here's a draft.", `${REFLECTION_DATE}T09:00:00.000Z`);
      await pool.query(
        `INSERT INTO messages (id, chat_id, role, content, kind, created_at)
         VALUES (?, ?, 'system', ?, 'chat', ?)`,
        [
          generateId("message"),
          chatId,
          JSON.stringify({ type: "feedback", rating: "up", targetMessageId: "msg_target_up" }),
          `${REFLECTION_DATE}T09:01:00.000Z`,
        ],
      );
      await pool.query(
        `INSERT INTO messages (id, chat_id, role, content, kind, created_at)
         VALUES (?, ?, 'system', ?, 'chat', ?)`,
        [
          generateId("message"),
          chatId,
          JSON.stringify({ type: "feedback", rating: "down", targetMessageId: "msg_target_down" }),
          `${REFLECTION_DATE}T09:02:00.000Z`,
        ],
      );

      let captured: WorkspaceReflectionInput | null = null;
      const reflectWorkspace: ReflectFn<WorkspaceReflectionInput> = async (input) => {
        captured = input;
        return { journal: "# stub\n" };
      };
      await runWorkspaceReflection({
        pool,
        home,
        date: REFLECTION_DATE,
        workspaceId: wsId,
        workspaceSlug: wsSlug,
        workspaceName: "WS Feedback",
        userId,
        userName: "reflector",
        agent: { id: agentId, name: "Reflector", model: "anthropic/claude-haiku-4-5" },
        reflectWorkspace,
      });

      expect(captured).not.toBeNull();
      const activity = captured!.activity;
      const feedbackLines = activity.filter((row) => row.body.startsWith("User reacted"));
      expect(feedbackLines).toHaveLength(2);
      expect(feedbackLines[0].body).toContain("👍 helpful");
      expect(feedbackLines[0].body).toContain("msg_target_up");
      expect(feedbackLines[1].body).toContain("👎 not helpful");
      expect(feedbackLines[1].body).toContain("msg_target_down");
    } finally {
      await pool.query(`DELETE FROM messages WHERE chat_id = ?`, [chatId]);
      await pool.query(`DELETE FROM chats WHERE id = ?`, [chatId]);
      await pool.query(`DELETE FROM workspace_agents WHERE workspace_id = ?`, [wsId]);
      await pool.query(`DELETE FROM workspaces WHERE id = ?`, [wsId]);
    }
  });

  it("skips silently when the workspace had no activity for the date", async () => {
    const reflectWorkspace: ReflectFn<WorkspaceReflectionInput> = async () => {
      throw new Error("should not be called");
    };
    const body = await runWorkspaceReflection({
      pool,
      home,
      date: REFLECTION_DATE,
      workspaceId: workspaceBId,
      workspaceSlug: workspaceBSlug,
      workspaceName: "WS B",
      userId,
      userName: "reflector",
      agent: { id: agentId, name: "Reflector", model: "anthropic/claude-haiku-4-5" },
      reflectWorkspace,
    });
    expect(body).toBeNull();

    // No journal file appeared.
    const journalDir = path.join(
      home,
      workspaceBSlug,
      ".memory",
      "journal",
    );
    const exists = await fs.stat(journalDir).catch(() => null);
    if (exists) {
      const entries = await fs.readdir(journalDir);
      expect(entries).toEqual([]);
    }
  });

  it("uses atomic write-then-rename: a concurrent user edit is never read as an empty/truncated file", async () => {
    // P87.1 — replace fs.writeFile with rename(tmp → target). The
    // concurrency property we care about: while reflection is mid-write,
    // a reader of the target file should see *some* coherent body
    // (either pre- or post-write), never a half-flushed or empty one.
    //
    // Strategy: race many concurrent writers against the journal target
    // and continuously read it, asserting every observation is a
    // complete, non-empty body. Without atomic rename, fs.writeFile
    // truncates the file before streaming bytes back in, so the
    // observer occasionally sees zero bytes.
    const memoryEditPath = "concurrency-prefs.md";
    const memoryAbs = path.join(
      home,
      workspaceASlug,
      ".memory",
      memoryEditPath,
    );
    await fs.mkdir(path.dirname(memoryAbs), { recursive: true });
    const baseline = "# Concurrency prefs\n\nbaseline body that pre-existed before the run.\n";
    await fs.writeFile(memoryAbs, baseline, "utf-8");

    const writers = Array.from({ length: 20 }, (_, i) =>
      runWorkspaceReflection({
        pool,
        home,
        date: REFLECTION_DATE,
        workspaceId: workspaceAId,
        workspaceSlug: workspaceASlug,
        workspaceName: "WS A",
        userId,
        userName: "reflector",
        agent: { id: agentId, name: "Reflector", model: "anthropic/claude-haiku-4-5" },
        reflectWorkspace: async () => ({
          journal: `# Journal — iteration ${i}\n`.padEnd(2048, "x"),
          memoryEdits: [
            { path: memoryEditPath, body: `# Concurrency prefs\n\niteration=${i}\n`.padEnd(1024, "y") },
          ],
        }),
      }),
    );

    // While writers are racing, observe the file repeatedly. A
    // truncated/partial read from a non-atomic write would surface as
    // an empty string here.
    let observations = 0;
    let stop = false;
    const observer = (async () => {
      while (!stop) {
        try {
          const body = await fs.readFile(memoryAbs, "utf-8");
          expect(body.length).toBeGreaterThan(0);
          // The body should be either the baseline or one of the
          // reflection iterations — always a coherent prefix.
          expect(body.startsWith("# Concurrency prefs")).toBe(true);
          observations += 1;
        } catch (err) {
          // ENOENT is acceptable in this race only if rename hasn't
          // landed yet; we pre-created the file so this should never
          // fire. Any other error is a failure.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    })();

    await Promise.all(writers);
    stop = true;
    await observer;

    expect(observations).toBeGreaterThan(0);

    // Final body matches one of the reflection writes (proves the
    // memory-edit path was actually exercised).
    const final = await fs.readFile(memoryAbs, "utf-8");
    expect(final).toMatch(/^# Concurrency prefs/);
    expect(final).toMatch(/iteration=/);
  });

  it("translates codex/* agent models so the daemon agent file lands on openai-codex/*", async () => {
    // The agent file the reflection sandbox writes ends up with the
    // `model:` line passed via `input.agent.model`. Pi exposes
    // OAuth-authed OpenAI under the provider id `openai-codex`; `codex`
    // is a Roomy-side UI relabel. Without translation here the daemon
    // resolves the agent against an unknown provider and 500s every
    // reflection.
    let captured: WorkspaceReflectionInput | null = null;
    const reflectWorkspace: ReflectFn<WorkspaceReflectionInput> = async (input) => {
      captured = input;
      return { journal: "# noop\n", memoryEdits: [] };
    };
    await runWorkspaceReflection({
      pool,
      home,
      date: REFLECTION_DATE,
      workspaceId: workspaceAId,
      workspaceSlug: workspaceASlug,
      workspaceName: "WS A",
      userId,
      userName: "reflector",
      agent: { id: agentId, name: "Reflector", model: "codex/gpt-5.5" },
      providerKeys: { OPENAI_API_KEY: "sk-key" },
      extraEnv: { PI_AUTH_JSON_BASE64: "eyJvcGVuYWktY29kZXgiOnsidHlwZSI6Im9hdXRoIn19" },
      reflectWorkspace,
    });
    expect(captured).not.toBeNull();
    expect(captured!.agent.model).toBe("openai-codex/gpt-5.5");
  });

  it("rejects malformed memory-edit paths (path traversal / non-md)", async () => {
    const reflectWorkspace: ReflectFn<WorkspaceReflectionInput> = async () => ({
      journal: "# Journal\n",
      memoryEdits: [
        { path: "../escape.md", body: "should not land" },
        { path: ".hidden.md", body: "should not land" },
        { path: "no-extension", body: "should not land" },
        { path: "valid.md", body: "valid body" },
      ],
    });
    await runWorkspaceReflection({
      pool,
      home,
      date: REFLECTION_DATE,
      workspaceId: workspaceAId,
      workspaceSlug: workspaceASlug,
      workspaceName: "WS A",
      userId,
      userName: "reflector",
      agent: { id: agentId, name: "Reflector", model: "anthropic/claude-haiku-4-5" },
      reflectWorkspace,
    });

    const memoryDir = path.join(home, workspaceASlug, ".memory");
    expect(await fs.readFile(path.join(memoryDir, "valid.md"), "utf-8")).toBe("valid body");
    // Path-traversal target must not exist.
    const escape = path.join(home, "escape.md");
    expect(await fs.stat(escape).catch(() => null)).toBeNull();
  });
});

describe("runDailyReflection", () => {
  it("does not resolve provider keys unless raw sandbox credential env is enabled", async () => {
    const previous = process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
    delete process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
    let resolvedKeys = false;
    const calls: WorkspaceReflectionInput[] = [];

    try {
      await runDailyReflection({
        pool,
        home,
        date: REFLECTION_DATE,
        resolveProviderKeys: async () => {
          resolvedKeys = true;
          return { OPENAI_API_KEY: "sk-should-not-resolve" };
        },
        reflectWorkspace: async (input) => {
          calls.push(input);
          return { journal: `# Journal\n\n${input.workspaceSlug}` };
        },
      });

      expect(resolvedKeys).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0].providerKeys).toEqual({});
    } finally {
      if (previous === undefined) delete process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV;
      else process.env.ROOMY_ALLOW_RAW_SANDBOX_CREDENTIAL_ENV = previous;
    }
  });

  it("runs only workspace-owned agents and does not write global user memory", async () => {
    const workspaceCalls: WorkspaceReflectionInput[] = [];

    const reflectWorkspace: ReflectFn<WorkspaceReflectionInput> = async (input) => {
      workspaceCalls.push(input);
      expect(input.agent.id).toBe(agentId);
      expect(input.userId).toBe(userId);
      return {
        journal: `# Journal — ${input.workspaceSlug} on ${input.date}\n${input.activity.length} message(s).`,
      };
    };

    // Reset memory dirs for both workspaces + user.
    await fs.rm(path.join(home, ".memory"), { recursive: true, force: true });
    await fs.rm(path.join(home, workspaceASlug, ".memory"), {
      recursive: true,
      force: true,
    });

    await runDailyReflection({
      pool,
      home,
      date: REFLECTION_DATE,
      reflectWorkspace,
    });

    // Workspace A had activity; B did not.
    expect(workspaceCalls.length).toBe(1);
    expect(workspaceCalls[0].workspaceSlug).toBe(workspaceASlug);

    const workspaceJournalPath = path.join(
      home,
      workspaceASlug,
      ".memory",
      "journal",
      `${REFLECTION_DATE}.md`,
    );
    const workspaceJournal = await fs.readFile(workspaceJournalPath, "utf-8");
    expect(workspaceJournal).toContain(workspaceASlug);

    const userMemory = await fs.stat(path.join(home, ".memory")).catch(() => null);
    expect(userMemory).toBeNull();
  });

  it("does not run any agent when no workspaces had activity", async () => {
    const reflectWorkspace: ReflectFn<WorkspaceReflectionInput> = async () => ({
      journal: "should not be called",
    });
    let workspaceCallCount = 0;

    await runDailyReflection({
      pool,
      home,
      date: "1999-01-01", // No activity on that date.
      reflectWorkspace: async (input) => {
        workspaceCallCount++;
        return reflectWorkspace(input);
      },
    });
    expect(workspaceCallCount).toBe(0);
  });
});

describe("scheduler-managed daily reflection tasks", () => {
  it("ensures one recurring internal reflection task per workspace", async () => {
    await pool.query(`DELETE FROM messages WHERE json_extract(content, '$.type') = 'reflection_request'`);

    await ensureDailyReflectionTasks({ pool, cron: "0 3 * * *" });
    await ensureDailyReflectionTasks({ pool, cron: "0 3 * * *" });

    const { rows } = await pool.query<{
      workspace_id: string;
      task_count: number;
      cron: string;
      state: string;
      content_type: string;
      chat_title: string;
    }>(
      `SELECT json_extract(m.content, '$.workspaceId') AS workspace_id,
              COUNT(*) AS task_count,
              MAX(m.cron) AS cron,
              MAX(m.state) AS state,
              MAX(json_extract(m.content, '$.type')) AS content_type,
              MAX(c.title) AS chat_title
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE m.kind = 'task'
         AND json_extract(m.content, '$.type') = 'reflection_request'
       GROUP BY json_extract(m.content, '$.workspaceId')
       ORDER BY workspace_id`,
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.workspace_id).sort()).toEqual([workspaceAId, workspaceBId].sort());
    for (const row of rows) {
      expect(Number(row.task_count)).toBe(1);
      expect(row.cron).toBe("0 3 * * *");
      expect(row.state).toBe("pending");
      expect(row.content_type).toBe("reflection_request");
      expect(row.chat_title).toBe("Workspace reflection");
    }

    const visibleChats = await queries.chats.listWithLatestMessage(pool, workspaceAId);
    expect(visibleChats.map((chat) => chat.title)).not.toContain("Workspace reflection");
  });

  it("moves existing reflection tasks from borrowed chats into the dedicated reflection chat", async () => {
    await pool.query(`DELETE FROM messages WHERE json_extract(content, '$.type') = 'reflection_request'`);
    const { rows: chatRows } = await pool.query<{ id: string }>(
      `SELECT id FROM chats WHERE workspace_id = ? AND title = 'WS A Chat' LIMIT 1`,
      [workspaceAId],
    );
    const borrowedChatId = chatRows[0].id;
    const messageId = generateId("message");
    await queries.messages.insert(pool, {
      id: messageId,
      chatId: borrowedChatId,
      role: "system",
      content: { type: "reflection_request", workspaceId: workspaceAId },
      state: "pending",
      executeAt: new Date(Date.now() + 60_000).toISOString(),
      cron: "0 3 * * *",
      agentId,
      kind: "task",
      title: "Daily workspace memory reflection",
    });

    await ensureDailyReflectionTasks({ pool, cron: "0 3 * * *" });

    const { rows } = await pool.query<{ chat_id: string; title: string }>(
      `SELECT m.chat_id, c.title
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE m.id = ?`,
      [messageId],
    );
    expect(rows[0].chat_id).not.toBe(borrowedChatId);
    expect(rows[0].title).toBe("Workspace reflection");
  });

  it("migrates legacy reflection-kind rows into ordinary tasks", async () => {
    await pool.query(`DELETE FROM messages WHERE json_extract(content, '$.type') = 'reflection_request'`);
    const { rows: chatRows } = await pool.query<{ id: string }>(
      `SELECT id FROM chats WHERE workspace_id = ? AND title = 'WS A Chat' LIMIT 1`,
      [workspaceAId],
    );
    const messageId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, kind, state, execute_at, cron, agent_id, title)
       VALUES (?, ?, 'system', ?, 'reflection', 'pending', ?, '0 3 * * *', ?, ?)`,
      [
        messageId,
        chatRows[0].id,
        JSON.stringify({ type: "reflection_request", workspaceId: workspaceAId }),
        new Date(Date.now() + 60_000).toISOString(),
        agentId,
        "Daily workspace memory reflection",
      ],
    );

    await ensureDailyReflectionTasks({ pool, cron: "0 3 * * *" });

    const migrated = await queries.messages.findById(pool, messageId);
    expect(migrated?.kind).toBe("task");
  });

  it("recomputes the next run when the reflection cron changes", async () => {
    await pool.query(`DELETE FROM messages WHERE json_extract(content, '$.type') = 'reflection_request'`);
    await ensureDailyReflectionTasks({ pool, cron: "0 3 * * *" });

    const { rows: beforeRows } = await pool.query<{ id: string; execute_at: string }>(
      `SELECT id, execute_at FROM messages
       WHERE kind = 'task'
         AND json_extract(content, '$.type') = 'reflection_request'
         AND json_extract(content, '$.workspaceId') = ?
       LIMIT 1`,
      [workspaceAId],
    );

    await ensureDailyReflectionTasks({ pool, cron: "0 4 * * *" });

    const updated = await queries.messages.findById(pool, beforeRows[0].id);
    expect(updated?.cron).toBe("0 4 * * *");
    expect(updated?.executeAt).not.toBe(beforeRows[0].execute_at);
  });

  it("fires a due reflection task through task-run scheduling and advances the cron", async () => {
    await pool.query(`DELETE FROM messages WHERE kind = 'task_run' OR json_extract(content, '$.type') = 'reflection_request'`);
    const dynamicDate = yesterdayDateLocal();
    const { rows: chatRows } = await pool.query<{ id: string }>(
      `SELECT id FROM chats WHERE workspace_id = ? ORDER BY updated_at LIMIT 1`,
      [workspaceAId],
    );
    await createMessage(chatRows[0].id, "user", "Remember the recurring reflection scheduler.", `${dynamicDate}T09:00:00.000Z`);

    await ensureDailyReflectionTasks({ pool, cron: "0 3 * * *" });
    const { rows: taskRows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE kind = 'task'
         AND json_extract(content, '$.type') = 'reflection_request'
         AND json_extract(content, '$.workspaceId') = ?
       LIMIT 1`,
      [workspaceAId],
    );
    const taskId = taskRows[0].id;
    await queries.messages.updateMessage(pool, taskId, {
      executeAt: new Date(Date.now() - 60_000).toISOString(),
      state: "pending",
    });

    const calls: WorkspaceReflectionInput[] = [];
    const mgr = createRunManager({
      pool,
      home,
      reflectWorkspace: async (input) => {
        calls.push(input);
        return { journal: `# Journal\n\nReflected ${input.workspaceSlug} on ${input.date}.` };
      },
    });

    await mgr.tickScheduled();

    expect(calls).toHaveLength(1);
    expect(calls[0].workspaceId).toBe(workspaceAId);
    expect(calls[0].date).toBe(dynamicDate);

    const parent = await queries.messages.findById(pool, taskId);
    expect(parent?.state).toBe("pending");
    expect(parent?.cron).toBe("0 3 * * *");
    expect(new Date(parent?.executeAt ?? 0).getTime()).toBeGreaterThan(Date.now());

    const { rows: runRows } = await pool.query<{ state: string }>(
      `SELECT state FROM messages WHERE parent_id = ? AND kind = 'task_run'`,
      [taskId],
    );
    expect(runRows).toEqual([{ state: "succeeded" }]);

    const journal = await fs.readFile(
      path.join(home, workspaceASlug, ".memory", "journal", `${dynamicDate}.md`),
      "utf-8",
    );
    expect(journal).toContain(workspaceASlug);
  });

  it("bypasses the generic exec driver for reflection tasks and replies with the reflection outcome", async () => {
    await pool.query(`DELETE FROM messages WHERE kind = 'task_run' OR json_extract(content, '$.type') = 'reflection_request'`);
    const dynamicDate = yesterdayDateLocal();
    const { rows: chatRows } = await pool.query<{ id: string }>(
      `SELECT id FROM chats WHERE workspace_id = ? ORDER BY updated_at LIMIT 1`,
      [workspaceAId],
    );
    await createMessage(chatRows[0].id, "user", "Reflect on the non-generic completion text.", `${dynamicDate}T09:30:00.000Z`);

    await ensureDailyReflectionTasks({ pool, cron: "0 3 * * *" });
    const { rows: taskRows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE kind = 'task'
         AND json_extract(content, '$.type') = 'reflection_request'
         AND json_extract(content, '$.workspaceId') = ?
       LIMIT 1`,
      [workspaceAId],
    );
    const taskId = taskRows[0].id;

    const mgr = createRunManager({
      pool,
      home,
      execRunFn: async (_runId, _agentId, _prompt, onLog) => {
        await onLog({
          runId: _runId,
          seq: 0,
          kind: "stdout",
          payload: JSON.stringify({ type: "text", part: { text: "Daily workspace reflection completed." } }),
        });
        return { exitCode: 0 };
      },
      reflectWorkspace: async (input) => ({
        journal: `# Journal\n\nReflected ${input.workspaceSlug} with a specific outcome.`,
      }),
    });

    await mgr.fireMessage(taskId, { manual: true });

    const { rows } = await pool.query<{ child_content: string }>(
      `SELECT child.content AS child_content
       FROM messages run
       JOIN messages child ON child.parent_id = run.id
       WHERE run.parent_id = ? AND run.kind = 'task_run'
       LIMIT 1`,
      [taskId],
    );
    const child = JSON.parse(rows[0].child_content) as { type: string; log: Array<{ kind: string }> };
    expect(child.type).toBe("events");
    const logText = JSON.stringify(child.log);
    expect(logText).toContain("Reflected");
    expect(logText).not.toContain("a reflection only this run could leave");
    expect(logText).toContain("- Reflected");
    expect(logText).not.toMatch(/\b[A-Za-z0-9_-]{1,3}( · [A-Za-z0-9_-]{1,3}){2,}\b/);
    expect(logText).not.toContain("The day folded into memory.");
    expect(logText).not.toContain("Daily workspace reflection completed.");
  });

  it("manual reflection run produces an observable task run even with no activity", async () => {
    await pool.query(`DELETE FROM messages WHERE kind = 'task_run' OR json_extract(content, '$.type') = 'reflection_request'`);
    await ensureDailyReflectionTasks({ pool, cron: "0 3 * * *" });
    const { rows: taskRows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE kind = 'task'
         AND json_extract(content, '$.type') = 'reflection_request'
         AND json_extract(content, '$.workspaceId') = ?
       LIMIT 1`,
      [workspaceBId],
    );
    const taskId = taskRows[0].id;
    const calls: WorkspaceReflectionInput[] = [];
    const mgr = createRunManager({
      pool,
      home,
      reflectWorkspace: async (input) => {
        calls.push(input);
        return { journal: `# Manual Reflection — ${input.date}\n\nActivity: ${input.activity.length}` };
      },
    });

    await mgr.fireMessage(taskId, { manual: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].workspaceId).toBe(workspaceBId);
    expect(calls[0].activity).toHaveLength(0);

    const parent = await queries.messages.findById(pool, taskId);
    expect(parent?.state).toBe("pending");

    const { rows } = await pool.query<{ run_state: string; child_content: string }>(
      `SELECT run.state AS run_state, child.content AS child_content
       FROM messages run
       JOIN messages child ON child.parent_id = run.id
       WHERE run.parent_id = ? AND run.kind = 'task_run'
       LIMIT 1`,
      [taskId],
    );
    expect(rows[0].run_state).toBe("succeeded");
    const child = JSON.parse(rows[0].child_content) as { type: string; log: Array<{ kind: string }> };
    expect(child.type).toBe("events");
    expect(child.log.length).toBeGreaterThan(0);
    const logText = JSON.stringify(child.log);
    expect(logText).toContain("Activity: 0");
    expect(logText).toMatch(/- Activity: 0/);
    expect(logText).not.toMatch(/\b[A-Za-z0-9_-]{1,3}( · [A-Za-z0-9_-]{1,3}){2,}\b/);
    expect(logText).not.toContain("Journal written");
  });

  it("logs a completed summary when a reflection returns an empty journal", async () => {
    await pool.query(`DELETE FROM messages WHERE kind = 'task_run' OR json_extract(content, '$.type') = 'reflection_request'`);
    await ensureDailyReflectionTasks({ pool, cron: "0 3 * * *" });
    const { rows: taskRows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE kind = 'task'
         AND json_extract(content, '$.type') = 'reflection_request'
         AND json_extract(content, '$.workspaceId') = ?
       LIMIT 1`,
      [workspaceBId],
    );
    const taskId = taskRows[0].id;
    const mgr = createRunManager({
      pool,
      home,
      reflectWorkspace: async () => ({ journal: "" }),
    });

    await mgr.fireMessage(taskId, { manual: true });

    const { rows } = await pool.query<{ child_content: string }>(
      `SELECT child.content AS child_content
       FROM messages run
       JOIN messages child ON child.parent_id = run.id
       WHERE run.parent_id = ? AND run.kind = 'task_run'
       LIMIT 1`,
      [taskId],
    );
    const child = JSON.parse(rows[0].child_content) as { type: string; log: Array<{ kind: string }> };
    expect(child.type).toBe("events");
    const logText = JSON.stringify(child.log);
    expect(logText).toContain("- Empty reflection.");
    expect(logText).not.toContain("Journal written");
    expect(logText).not.toContain("Notes gathered");
    expect(logText).not.toContain("Memory unchanged");
    expect(logText).not.toMatch(/\b[A-Za-z0-9_-]{1,3}( · [A-Za-z0-9_-]{1,3}){2,}\b/);
  });

  it("logs extremely brief grounded reflection summaries", async () => {
    await pool.query(`DELETE FROM messages WHERE kind = 'task_run' OR json_extract(content, '$.type') = 'reflection_request'`);
    await ensureDailyReflectionTasks({ pool, cron: "0 3 * * *" });
    const { rows: taskRows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE kind = 'task'
         AND json_extract(content, '$.type') = 'reflection_request'
         AND json_extract(content, '$.workspaceId') = ?
       LIMIT 1`,
      [workspaceBId],
    );
    const taskId = taskRows[0].id;
    const mgr = createRunManager({
      pool,
      home,
      reflectWorkspace: async () => ({ journal: "# Daily Reflection\n\nSame small note" }),
    });

    await mgr.fireMessage(taskId, { manual: true });
    await mgr.fireMessage(taskId, { manual: true });

    const { rows } = await pool.query<{ child_content: string }>(
      `SELECT child.content AS child_content
       FROM messages run
       JOIN messages child ON child.parent_id = run.id
       WHERE run.parent_id = ? AND run.kind = 'task_run'
       ORDER BY run.created_at ASC`,
      [taskId],
    );
    const outputs = rows
      .map((row) => JSON.stringify(JSON.parse(row.child_content)))
      .filter((output) => output.includes("Same small note"));
    expect(outputs).toHaveLength(2);
    for (const output of outputs) {
      expect(output).toContain("- Same small note");
      expect(output).not.toMatch(/Reflection result|Reflection note|Daily reflection|Workspace reflection/);
      expect(output).not.toContain("What happened:");
      expect(output).not.toContain("Other notes:");
      expect(output).not.toContain("The day folded into memory.");
    }
  });

  it("keeps concrete open-thread bullets", async () => {
    await pool.query(`DELETE FROM messages WHERE kind = 'task_run' OR json_extract(content, '$.type') = 'reflection_request'`);
    await ensureDailyReflectionTasks({ pool, cron: "0 3 * * *" });
    const { rows: taskRows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE kind = 'task'
         AND json_extract(content, '$.type') = 'reflection_request'
         AND json_extract(content, '$.workspaceId') = ?
       LIMIT 1`,
      [workspaceAId],
    );
    const taskId = taskRows[0].id;
    const mgr = createRunManager({
      pool,
      home,
      reflectWorkspace: async () => ({
        journal: "# Daily Reflection\n\n- Open thread: confirm launch date.",
      }),
    });

    await mgr.fireMessage(taskId, { manual: true });

    const { rows } = await pool.query<{ child_content: string }>(
      `SELECT child.content AS child_content
       FROM messages run
       JOIN messages child ON child.parent_id = run.id
       WHERE run.parent_id = ? AND run.kind = 'task_run'
       LIMIT 1`,
      [taskId],
    );
    const child = JSON.parse(rows[0].child_content) as { type: string; log: Array<{ kind: string }> };
    const logText = JSON.stringify(child.log);
    expect(logText).toContain("- Open thread: confirm launch date");
    expect(logText).not.toContain("No concrete reflection");
  });

  it("logs a quiet summary when a scheduled reflection has no activity", async () => {
    await pool.query(`DELETE FROM messages WHERE kind = 'task_run' OR json_extract(content, '$.type') = 'reflection_request'`);
    await ensureDailyReflectionTasks({ pool, cron: "0 3 * * *" });
    const { rows: taskRows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE kind = 'task'
         AND json_extract(content, '$.type') = 'reflection_request'
         AND json_extract(content, '$.workspaceId') = ?
       LIMIT 1`,
      [workspaceBId],
    );
    const taskId = taskRows[0].id;
    await queries.messages.updateMessage(pool, taskId, {
      executeAt: new Date(Date.now() - 60_000).toISOString(),
      state: "pending",
    });

    const calls: WorkspaceReflectionInput[] = [];
    const mgr = createRunManager({
      pool,
      home,
      reflectWorkspace: async (input) => {
        calls.push(input);
        return { journal: "# Should not run\n" };
      },
    });

    await mgr.tickScheduled();

    expect(calls).toHaveLength(0);
    const { rows } = await pool.query<{ run_state: string; child_content: string }>(
      `SELECT run.state AS run_state, child.content AS child_content
       FROM messages run
       JOIN messages child ON child.parent_id = run.id
       WHERE run.parent_id = ? AND run.kind = 'task_run'
       LIMIT 1`,
      [taskId],
    );
    expect(rows[0].run_state).toBe("succeeded");
    const child = JSON.parse(rows[0].child_content) as { type: string; log: Array<{ kind: string }> };
    expect(child.type).toBe("events");
    const logText = JSON.stringify(child.log);
    expect(logText).not.toContain("The workspace slept quietly.");
    expect(logText).not.toContain("No activity found");
    expect(logText).not.toContain("No journal written");
    expect(logText).toContain("- No activity.");
    expect(logText).not.toContain("Memory unchanged");
    expect(logText).not.toContain("quiet-");
    expect(logText).not.toMatch(/memory glowing|archive|transcript|moonlight|mist/);
    expect(logText).not.toMatch(/\b[A-Za-z0-9_-]{1,3}( · [A-Za-z0-9_-]{1,3}){2,}\b/);
  });

  it("keeps legitimate work about no-activity reflection behavior", async () => {
    await pool.query(`DELETE FROM messages WHERE kind = 'task_run' OR json_extract(content, '$.type') = 'reflection_request'`);
    await ensureDailyReflectionTasks({ pool, cron: "0 3 * * *" });
    const { rows: taskRows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE kind = 'task'
         AND json_extract(content, '$.type') = 'reflection_request'
         AND json_extract(content, '$.workspaceId') = ?
       LIMIT 1`,
      [workspaceAId],
    );
    const taskId = taskRows[0].id;
    const mgr = createRunManager({
      pool,
      home,
      reflectWorkspace: async () => ({
        journal: "# Daily Reflection\n\nFixed no activity reflection replies.",
      }),
    });

    await mgr.fireMessage(taskId, { manual: true });

    const { rows } = await pool.query<{ child_content: string }>(
      `SELECT child.content AS child_content
       FROM messages run
       JOIN messages child ON child.parent_id = run.id
       WHERE run.parent_id = ? AND run.kind = 'task_run'
       LIMIT 1`,
      [taskId],
    );
    const child = JSON.parse(rows[0].child_content) as { type: string; log: Array<{ kind: string }> };
    const logText = JSON.stringify(child.log);
    expect(logText).toContain("- Fixed no activity reflection replies");
    expect(logText).not.toContain("- No activity.");
    expect(logText).not.toContain("- No concrete reflection.");
  });

  it("keeps no-activity decisions even without implementation verbs", async () => {
    await pool.query(`DELETE FROM messages WHERE kind = 'task_run' OR json_extract(content, '$.type') = 'reflection_request'`);
    await ensureDailyReflectionTasks({ pool, cron: "0 3 * * *" });
    const { rows: taskRows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE kind = 'task'
         AND json_extract(content, '$.type') = 'reflection_request'
         AND json_extract(content, '$.workspaceId') = ?
       LIMIT 1`,
      [workspaceAId],
    );
    const taskId = taskRows[0].id;
    const mgr = createRunManager({
      pool,
      home,
      reflectWorkspace: async () => ({
        journal: "# Daily Reflection\n\nDecided no activity replies stay brief.",
      }),
    });

    await mgr.fireMessage(taskId, { manual: true });

    const { rows } = await pool.query<{ child_content: string }>(
      `SELECT child.content AS child_content
       FROM messages run
       JOIN messages child ON child.parent_id = run.id
       WHERE run.parent_id = ? AND run.kind = 'task_run'
       LIMIT 1`,
      [taskId],
    );
    const child = JSON.parse(rows[0].child_content) as { type: string; log: Array<{ kind: string }> };
    const logText = JSON.stringify(child.log);
    expect(logText).toContain("- Decided no activity replies stay brief");
    expect(logText).not.toContain("- No activity.");
  });

  it("keeps real charted activity instead of mistaking it for no activity", async () => {
    await pool.query(`DELETE FROM messages WHERE kind = 'task_run' OR json_extract(content, '$.type') = 'reflection_request'`);
    await ensureDailyReflectionTasks({ pool, cron: "0 3 * * *" });
    const { rows: taskRows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE kind = 'task'
         AND json_extract(content, '$.type') = 'reflection_request'
         AND json_extract(content, '$.workspaceId') = ?
       LIMIT 1`,
      [workspaceAId],
    );
    const taskId = taskRows[0].id;
    const mgr = createRunManager({
      pool,
      home,
      reflectWorkspace: async () => ({
        journal: "# Daily Reflection\n\nCharted Q2 revenue trends and prepared a board for review.",
      }),
    });

    await mgr.fireMessage(taskId, { manual: true });

    const { rows } = await pool.query<{ child_content: string }>(
      `SELECT child.content AS child_content
       FROM messages run
       JOIN messages child ON child.parent_id = run.id
       WHERE run.parent_id = ? AND run.kind = 'task_run'
       LIMIT 1`,
      [taskId],
    );
    const child = JSON.parse(rows[0].child_content) as { type: string; log: Array<{ kind: string }> };
    const logText = JSON.stringify(child.log);
    expect(logText).toContain("Charted Q2 revenue trends");
    expect(logText).not.toMatch(/no messages|quiet|no chat trace|only silence/);
    expect(logText).toContain("- Charted Q2 revenue trends");
  });
});
