import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { Pool, runMigrations } from "@roomy-ai/db";
import { generateId } from "@roomy-ai/shared";
import { ensureLayout, ensureWorkspaceLayout, workspaceRootPath } from "@roomy-ai/storage";
import {
  findLibraryItems,
  resetWorkspaceFileIndexRefreshCacheForTests,
} from "../src/routes/search.js";
import { upload } from "../src/routes/library.js";

let pool: Pool;
let home: string;
let dbDir: string;
let userId: string;
let workspaceId: string;
let workspaceSlug: string;

beforeAll(async () => {
  dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-find-library-db-"));
  pool = new Pool({ path: path.join(dbDir, "test.sqlite3") });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-find-library-"));
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

beforeEach(() => {
  resetWorkspaceFileIndexRefreshCacheForTests();
  vi.restoreAllMocks();
});

async function writeWorkspaceFile(relPath: string, body: string): Promise<void> {
  const abs = path.join(workspaceRootPath(home, workspaceSlug), relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, "utf-8");
}

describe("findLibraryItems", () => {
  it("discovers fragment manifests with params_schema via the existing file index", async () => {
    await writeWorkspaceFile(
      "todos.app/fragments/list/roomy.fragment.json",
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

  it("reuses a fresh library index for repeated lookups", async () => {
    await writeWorkspaceFile("notes/reuse-index.md", "Reusable index notes");
    const querySpy = vi.spyOn(pool, "query");

    await findLibraryItems(pool, { pool, home }, userId, { workspaceId, query: "Reusable" });
    await findLibraryItems(pool, { pool, home }, userId, { workspaceId, query: "Reusable" });

    const deleteRefreshes = querySpy.mock.calls.filter(([sql]) => (
      typeof sql === "string" && sql.includes("DELETE FROM chat_search_index")
    ));
    expect(deleteRefreshes).toHaveLength(1);
  });

  it("refreshes the library index after route-level file writes", async () => {
    await writeWorkspaceFile("notes/pre-upload.md", "Pre upload notes");
    const querySpy = vi.spyOn(pool, "query");

    await findLibraryItems(pool, { pool, home }, userId, { workspaceId, query: "Pre upload" });
    await upload(
      { pool, home },
      workspaceId,
      {
        name: "post-upload.md",
        mime: "text/markdown",
        stream: Readable.from(["Post upload notes"]),
      },
      () => {},
    );

    const hits = await findLibraryItems(pool, { pool, home }, userId, { workspaceId, query: "Post upload" });

    expect(hits.some((hit) => hit.path === "post-upload.md")).toBe(true);
    const deleteRefreshes = querySpy.mock.calls.filter(([sql]) => (
      typeof sql === "string" && sql.includes("DELETE FROM chat_search_index")
    ));
    expect(deleteRefreshes).toHaveLength(2);
  });

  it("surfaces Roomy-shipped global apps in every workspace's library", async () => {
    const globalAppDir = path.join(home, ".apps", "chat-forms.app");
    await fs.mkdir(path.join(globalAppDir, "fragments", "yes-no"), { recursive: true });
    await fs.writeFile(
      path.join(globalAppDir, "roomy.app.json"),
      JSON.stringify({
        name: "chat-forms",
        description: "Built-in forms for agents to ask the user structured questions via UI.",
        capabilities: ["chats.write"],
        fragments: ["yes-no"],
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(globalAppDir, "fragments", "yes-no", "roomy.fragment.json"),
      JSON.stringify({
        name: "yes-no",
        description: "Ask the user a yes/no question via UI buttons.",
        capabilities: ["chats.write"],
        params: { question: "The yes/no question to display." },
      }),
      "utf-8",
    );

    const apps = await findLibraryItems(pool, { pool, home }, userId, { kind: "app" });
    expect(apps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "app",
        name: "chat-forms",
        path: "/opt/roomy-apps/chat-forms.app",
        workspaceSlug: "_roomy_apps",
      }),
    ]));

    const frags = await findLibraryItems(pool, { pool, home }, userId, { kind: "fragment" });
    const yesNo = frags.find((hit) => hit.path === "/opt/roomy-apps/chat-forms.app/dist/fragments/yes-no");
    expect(yesNo).toMatchObject({
      kind: "fragment",
      name: "yes-no",
      workspaceSlug: "_roomy_apps",
      params_schema: { question: "The yes/no question to display." },
    });

    // Query-based filtering uses substring match across name + description.
    const queried = await findLibraryItems(pool, { pool, home }, userId, { query: "yes/no" });
    expect(queried.some((hit) => hit.path === "/opt/roomy-apps/chat-forms.app/dist/fragments/yes-no")).toBe(true);

    // Even when the search is scoped to a specific workspace, global apps still show up.
    const inWorkspace = await findLibraryItems(pool, { pool, home }, userId, { kind: "app", workspaceId });
    expect(inWorkspace.some((hit) => hit.path === "/opt/roomy-apps/chat-forms.app")).toBe(true);
  });
});
