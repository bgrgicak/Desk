/**
 * Integration test: invokes the production reflection callback against
 * the real `opencode` CLI on the host. Asserts the parsed result is
 * shaped like the prompt asks for — non-empty journal, array of
 * memoryEdits — without locking us into a specific journal body the
 * model is free to vary.
 *
 * Skipped when `opencode` isn't on PATH so CI environments without the
 * CLI don't fail this test. The local `npm run ci:local` mirror has it.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, queries, runMigrations } from "@agent-desk/db";
import { generateId } from "@agent-desk/shared";
import { ensureWorkspaceLayout } from "@agent-desk/storage";
import { productionReflectWorkspace } from "../../src/reflectFn.js";

function opencodeAvailable(): boolean {
  try {
    const result = spawnSync("opencode", ["--version"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

const SKIP = !opencodeAvailable();
const describeIf = SKIP ? describe.skip : describe;

let pool: Pool;
let home: string;
let userId: string;
let workspaceId: string;
let workspaceSlug: string;
let agentId: string;

beforeAll(async () => {
  if (SKIP) return;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-reflect-runtime-"));
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-reflect-runtime-db-"));
  pool = new Pool({ path: path.join(dbDir, "test.sqlite3") });
  await runMigrations(pool);
  userId = generateId("user");
  workspaceId = generateId("workspace");
  workspaceSlug = `reflect-${workspaceId.slice(-6)}`;
  agentId = generateId("agent");
  await pool.query(
    `INSERT INTO users (id, username, password_hash, email)
     VALUES (?, 'reflector', 'hash', 'reflect@example.com')`,
    [userId],
  );
  await queries.agents.insert(pool, {
    id: agentId,
    userId,
    name: "Workspace Reflector",
    model: "opencode/big-pickle",
  });
  await queries.workspaces.insert(pool, {
    id: workspaceId,
    userId,
    name: "Kanban",
    path: workspaceSlug,
  });
  await queries.workspaceAgents.addToWorkspace(pool, workspaceId, agentId);
  await ensureWorkspaceLayout(home, workspaceSlug);
});

afterAll(async () => {
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
});

describeIf("productionReflectWorkspace (real opencode)", () => {
  it("returns a non-empty journal and an array of memory edits", async () => {
    // 5-minute timeout: the gpt-5-nano free model is slow but free.
    const result = await productionReflectWorkspace({
      pool,
      home,
      workspaceId,
      workspaceSlug,
      workspaceName: "Kanban",
      userId,
      userName: "reflector",
      agent: { id: agentId, name: "Workspace Reflector", model: "opencode/big-pickle" },
      date: "2026-05-05",
      priorJournals: [
        {
          date: "2026-05-04",
          body: "# Journal 2026-05-04\n\nThe user accepted todo/doing/done as the canonical kanban columns.",
        },
      ],
      activity: [
        {
          chatId: "chat_demo",
          role: "user",
          createdAt: "2026-05-05T10:00:00.000Z",
          body: "Set up the kanban board with todo, doing, done columns.",
        },
        {
          chatId: "chat_demo",
          role: "agent",
          createdAt: "2026-05-05T10:01:00.000Z",
          body: "Done. Added the three columns.",
        },
        {
          chatId: "chat_demo",
          role: "user",
          createdAt: "2026-05-05T10:05:00.000Z",
          body: "Move the Q2 review onto the board.",
        },
      ],
    });

    expect(typeof result.journal).toBe("string");
    expect(result.journal.length).toBeGreaterThan(0);
    // The reflection prompt asks for a markdown body with bullets and
    // section breaks; either a leading "# heading" or any "## section"
    // marker proves the model produced structured markdown rather than
    // a degraded `(reflection failed: …)` placeholder.
    const hasMarkdownStructure =
      result.journal.includes("# ") ||
      result.journal.includes("## ") ||
      result.journal.includes("- ");
    expect(
      hasMarkdownStructure,
      `journal should contain markdown structure; got: ${result.journal.slice(0, 200)}`,
    ).toBe(true);
    // Reflection must never mark itself as degraded for a healthy call.
    expect(result.journal.startsWith("(reflection failed:")).toBe(false);

    // memoryEdits is optional but, if present, must be an array of
    // { path, body } objects.
    if (result.memoryEdits !== undefined) {
      expect(Array.isArray(result.memoryEdits)).toBe(true);
      for (const edit of result.memoryEdits) {
        expect(typeof edit.path).toBe("string");
        expect(typeof edit.body).toBe("string");
      }
    }
  }, 240_000);
});
