import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Pool, runMigrations } from "@agent-desk/db";
import { generateId } from "@agent-desk/shared";
import { ensureLayout, ensureWorkspaceLayout, workspaceRootPath } from "@agent-desk/storage";
import { findLibraryItems } from "../src/routes/search.js";

let pool: Pool;
let home: string;
let dbDir: string;
let userId: string;
let workspaceId: string;
let workspaceSlug: string;

beforeAll(async () => {
  dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-find-library-db-"));
  pool = new Pool({ path: path.join(dbDir, "test.sqlite3") });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-find-library-"));
  await ensureLayout(home);

  userId = generateId("user");
  workspaceId = generateId("workspace");
  workspaceSlug = `find-${workspaceId.slice(-6)}`;
  await pool.query(
    `INSERT INTO users (id, username, password_hash, email) VALUES (?, 'find-user', 'hash', 'find@example.com')`,
    [userId],
  );
  await pool.query(
    `INSERT INTO workspaces (id, user_id, name, path) VALUES (?, ?, 'Find', ?)`,
    [workspaceId, userId, workspaceSlug],
  );
  await ensureWorkspaceLayout(home, workspaceSlug);
});

afterAll(async () => {
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbDir) await fs.rm(dbDir, { recursive: true, force: true });
});

async function writeWorkspaceFile(relPath: string, body: string): Promise<void> {
  const abs = path.join(workspaceRootPath(home, workspaceSlug), relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, "utf-8");
}

describe("findLibraryItems", () => {
  it("discovers fragment manifests with params_schema via the existing file index", async () => {
    await writeWorkspaceFile(
      "todos.app/fragments/list/desk.fragment.json",
      JSON.stringify({
        name: "todo-list",
        description: "Inline list view of todos.",
        params: { "filter?": "all | open | done" },
      }),
    );

    const hits = await findLibraryItems(pool, { pool, home }, userId, {
      query: "inline list",
      kind: "fragment",
      workspaceId,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      kind: "fragment",
      path: "todos.app/dist/fragments/list",
      name: "todo-list",
      params_schema: { "filter?": "all | open | done" },
    });
  });

  it("returns recent notes when query is omitted", async () => {
    await writeWorkspaceFile("notes/kanban.md", "Kanban setup notes");
    const hits = await findLibraryItems(pool, { pool, home }, userId, { workspaceId });
    expect(hits.some((hit) => hit.kind === "note" && hit.path === "notes/kanban.md")).toBe(true);
  });
});
