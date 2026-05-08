import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool } from "@agent-desk/db";
import { runMigrations, queries } from "@agent-desk/db";
import { generateId } from "@agent-desk/shared";
import {
  runDailyReflection,
  runWorkspaceReflection,
  yesterdayDateLocal,
  type ReflectFn,
  type WorkspaceReflectionInput,
} from "../src/reflection.js";

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
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-reflection-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-reflection-"));

  userId = generateId("user");
  await pool.query(
    `INSERT INTO users (id, username, password_hash, email)
     VALUES (?, 'reflector', 'hash', 'reflect@example.com')`,
    [userId],
  );
  agentId = generateId("agent");
  await pool.query(
    `INSERT INTO agents (id, user_id, name, model)
     VALUES (?, ?, ?, 'opencode/big-pickle')`,
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
    await fs.rm(path.join(home, "Desk", "workspaces", workspaceASlug, ".memory"), {
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
      agent: { id: agentId, name: "Reflector", model: "opencode/big-pickle" },
      reflectWorkspace,
    });

    expect(body).toContain("kanban board");

    const journalPath = path.join(
      home,
      "Desk",
      "workspaces",
      workspaceASlug,
      ".memory",
      "journal",
      `${REFLECTION_DATE}.md`,
    );
    const journal = await fs.readFile(journalPath, "utf-8");
    expect(journal).toContain(REFLECTION_DATE);

    const editPath = path.join(
      home,
      "Desk",
      "workspaces",
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
      "Desk",
      "workspaces",
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
      agent: { id: agentId, name: "Reflector", model: "opencode/big-pickle" },
      reflectWorkspace,
    });
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
      agent: { id: agentId, name: "Reflector", model: "opencode/big-pickle" },
      reflectWorkspace,
    });
    expect(body).toBeNull();

    // No journal file appeared.
    const journalDir = path.join(
      home,
      "Desk",
      "workspaces",
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
      "Desk",
      "workspaces",
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
        agent: { id: agentId, name: "Reflector", model: "opencode/big-pickle" },
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
      agent: { id: agentId, name: "Reflector", model: "opencode/big-pickle" },
      reflectWorkspace,
    });

    const memoryDir = path.join(home, "Desk", "workspaces", workspaceASlug, ".memory");
    expect(await fs.readFile(path.join(memoryDir, "valid.md"), "utf-8")).toBe("valid body");
    // Path-traversal target must not exist.
    const escape = path.join(home, "Desk", "workspaces", "escape.md");
    expect(await fs.stat(escape).catch(() => null)).toBeNull();
  });
});

describe("runDailyReflection", () => {
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
    await fs.rm(path.join(home, "Desk", ".memory"), { recursive: true, force: true });
    await fs.rm(path.join(home, "Desk", "workspaces", workspaceASlug, ".memory"), {
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
      "Desk",
      "workspaces",
      workspaceASlug,
      ".memory",
      "journal",
      `${REFLECTION_DATE}.md`,
    );
    const workspaceJournal = await fs.readFile(workspaceJournalPath, "utf-8");
    expect(workspaceJournal).toContain(workspaceASlug);

    const userMemory = await fs.stat(path.join(home, "Desk", ".memory")).catch(() => null);
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
