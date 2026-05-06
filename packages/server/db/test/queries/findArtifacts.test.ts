import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type Pool } from "../../src/pool.js";
import { generateId } from "@agent-desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as findArtifacts from "../../src/queries/findArtifacts.js";

let pool: Pool;
const wsASlug = "wsa";
const wsBSlug = "wsb";

async function indexLibraryRow(
  kind: "app" | "fragment" | "note" | "doc",
  refId: string,
  workspaceSlug: string,
  body: string,
  createdAt: string = new Date().toISOString(),
): Promise<void> {
  await pool.query(
    `INSERT OR REPLACE INTO chat_search_index
       (ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    [refId, body, body.toLowerCase(), workspaceSlug, kind, createdAt],
  );
}

beforeAll(async () => {
  pool = await setupTestDb();
  // Seed library content directly into the index — findArtifacts reads
  // only from there, so we don't need real workspace rows for these
  // tests.
  await indexLibraryRow(
    "app",
    "todos.app",
    wsASlug,
    "todos\nManage daily tasks and pin them across chats.\n",
    "2026-01-01T00:00:00.000Z",
  );
  await indexLibraryRow(
    "fragment",
    "todos.app/fragments/list",
    wsASlug,
    "list\nInline list view of todos.\nfilter?=all | open | done",
    "2026-01-02T00:00:00.000Z",
  );
  await indexLibraryRow(
    "note",
    "notes/kanban.md",
    wsASlug,
    "Kanban setup\n\nWe use a kanban board with todo, doing, done columns.",
    "2026-01-03T00:00:00.000Z",
  );
  await indexLibraryRow(
    "doc",
    "data/owls.json",
    wsBSlug,
    "{\"feature\":\"watercolor owls\"}",
    "2026-01-04T00:00:00.000Z",
  );
  // A chat-message row should NEVER be returned by findArtifacts.
  await pool.query(
    `INSERT INTO chat_search_index
       (ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at)
     VALUES (?, ?, ?, ?, ?, 'message', ?)`,
    [
      generateId("message"),
      "irrelevant kanban chat message",
      "irrelevant kanban chat message",
      generateId("chat"),
      wsASlug,
      "2026-01-05T00:00:00.000Z",
    ],
  );
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("findArtifacts", () => {
  it("returns apps and fragments scored against name + description", async () => {
    const hits = await findArtifacts.findArtifacts(pool, { query: "todos" });
    const apps = hits.filter((h) => h.kind === "app");
    expect(apps.length).toBeGreaterThanOrEqual(1);
    expect(apps[0].name).toBe("todos");
    expect(apps[0].description).toMatch(/Manage daily tasks/);
  });

  it("filters by kind=note", async () => {
    const hits = await findArtifacts.findArtifacts(pool, {
      query: "kanban",
      kind: "note",
    });
    expect(hits.length).toBe(1);
    expect(hits[0].kind).toBe("note");
    expect(hits[0].path).toBe("notes/kanban.md");
  });

  it("excludes chat messages even when their content matches", async () => {
    const hits = await findArtifacts.findArtifacts(pool, { query: "kanban" });
    for (const hit of hits) {
      expect(hit.kind).not.toBe("message" as never);
    }
  });

  it("scopes to one workspace by default", async () => {
    const hits = await findArtifacts.findArtifacts(pool, {
      query: "owls",
      workspaceSlug: wsBSlug,
    });
    expect(hits.length).toBe(1);
    expect(hits[0].workspaceSlug).toBe(wsBSlug);

    const empty = await findArtifacts.findArtifacts(pool, {
      query: "owls",
      workspaceSlug: wsASlug,
    });
    expect(empty).toEqual([]);
  });

  it("widens to all workspaces with workspaceSlug='*'", async () => {
    const hits = await findArtifacts.findArtifacts(pool, {
      query: "owls",
      workspaceSlug: "*",
    });
    expect(hits.length).toBe(1);
    expect(hits[0].workspaceSlug).toBe(wsBSlug);
  });

  it("returns recently-modified artifacts when query is omitted", async () => {
    const hits = await findArtifacts.findArtifacts(pool, {
      workspaceSlug: wsASlug,
    });
    expect(hits.length).toBeGreaterThanOrEqual(3);
    // Newest first.
    expect(hits[0].lastModified >= hits[1].lastModified).toBe(true);
  });

  it("matches fragment params (params are part of the indexed body)", async () => {
    const hits = await findArtifacts.findArtifacts(pool, {
      query: "filter",
      kind: "fragment",
    });
    expect(hits.length).toBe(1);
    expect(hits[0].path).toBe("todos.app/fragments/list");
  });
});
