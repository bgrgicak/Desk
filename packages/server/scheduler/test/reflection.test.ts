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
  yesterdayDateUTC,
  type ReflectFn,
  type WorkspaceReflectionInput,
  type UserReflectionInput,
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

describe("yesterdayDateUTC", () => {
  it("formats yesterday in UTC as YYYY-MM-DD", () => {
    const out = yesterdayDateUTC(new Date("2026-05-06T01:00:00.000Z"));
    expect(out).toBe("2026-05-05");
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
    const reflectUser: ReflectFn<UserReflectionInput> = async () => ({ journal: "ignored" });

    const body = await runWorkspaceReflection({
      pool,
      home,
      date: REFLECTION_DATE,
      workspaceId: workspaceAId,
      workspaceSlug: workspaceASlug,
      workspaceName: "WS A",
      reflectWorkspace,
      reflectUser,
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

  it("skips silently when the workspace had no activity for the date", async () => {
    const reflectWorkspace: ReflectFn<WorkspaceReflectionInput> = async () => {
      throw new Error("should not be called");
    };
    const reflectUser: ReflectFn<UserReflectionInput> = async () => ({ journal: "" });

    const body = await runWorkspaceReflection({
      pool,
      home,
      date: REFLECTION_DATE,
      workspaceId: workspaceBId,
      workspaceSlug: workspaceBSlug,
      workspaceName: "WS B",
      reflectWorkspace,
      reflectUser,
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
    const reflectUser: ReflectFn<UserReflectionInput> = async () => ({ journal: "" });

    await runWorkspaceReflection({
      pool,
      home,
      date: REFLECTION_DATE,
      workspaceId: workspaceAId,
      workspaceSlug: workspaceASlug,
      workspaceName: "WS A",
      reflectWorkspace,
      reflectUser,
    });

    const memoryDir = path.join(home, "Desk", "workspaces", workspaceASlug, ".memory");
    expect(await fs.readFile(path.join(memoryDir, "valid.md"), "utf-8")).toBe("valid body");
    // Path-traversal target must not exist.
    const escape = path.join(home, "Desk", "workspaces", "escape.md");
    expect(await fs.stat(escape).catch(() => null)).toBeNull();
  });
});

describe("runDailyReflection", () => {
  it("runs per-workspace and per-user passes, calling the user roll-up only once with all journal bodies", async () => {
    const workspaceCalls: WorkspaceReflectionInput[] = [];
    const userCalls: UserReflectionInput[] = [];

    const reflectWorkspace: ReflectFn<WorkspaceReflectionInput> = async (input) => {
      workspaceCalls.push(input);
      return {
        journal: `# Journal — ${input.workspaceSlug} on ${input.date}\n${input.activity.length} message(s).`,
      };
    };
    const reflectUser: ReflectFn<UserReflectionInput> = async (input) => {
      userCalls.push(input);
      return {
        journal: `# User journal — ${input.date}\nWorkspaces touched: ${input.workspaceJournals
          .map((j) => j.workspaceSlug)
          .join(", ")}`,
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
      reflectUser,
    });

    // Workspace A had activity; B did not.
    expect(workspaceCalls.length).toBe(1);
    expect(workspaceCalls[0].workspaceSlug).toBe(workspaceASlug);

    // The user pass receives only WS A's journal.
    expect(userCalls.length).toBe(1);
    expect(userCalls[0].workspaceJournals.length).toBe(1);
    expect(userCalls[0].workspaceJournals[0].workspaceSlug).toBe(workspaceASlug);

    // User-level journal landed.
    const userJournalPath = path.join(home, "Desk", ".memory", "journal", `${REFLECTION_DATE}.md`);
    const userJournal = await fs.readFile(userJournalPath, "utf-8");
    expect(userJournal).toContain(workspaceASlug);
  });

  it("does not run the user roll-up when no workspaces had activity", async () => {
    const reflectWorkspace: ReflectFn<WorkspaceReflectionInput> = async () => ({
      journal: "should not be called",
    });
    let userCallCount = 0;
    const reflectUser: ReflectFn<UserReflectionInput> = async () => {
      userCallCount++;
      return { journal: "" };
    };

    await runDailyReflection({
      pool,
      home,
      date: "1999-01-01", // No activity on that date.
      reflectWorkspace,
      reflectUser,
    });
    expect(userCallCount).toBe(0);
  });
});
