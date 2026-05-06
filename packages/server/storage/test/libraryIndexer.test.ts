import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Pool } from "@agent-desk/db";
import { runMigrations } from "@agent-desk/db";
import { generateId } from "@agent-desk/shared";
import {
  ensureLayout,
  ensureWorkspaceLayout,
  workspaceRootPath,
  indexLibraryFile,
  indexAppManifest,
  indexFragmentManifest,
  unindexLibraryPath,
  backfillWorkspaceLibrary,
} from "../src/index.js";

let pool: Pool;
let home: string;
let dbPath: string;
let workspaceASlug: string;
let workspaceAId: string;

beforeAll(async () => {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-libidx-db-"));
  dbPath = path.join(dbDir, "test.sqlite3");
  pool = new Pool({ path: dbPath });
  await runMigrations(pool);

  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-libidx-"));
  await ensureLayout(home);

  // Synthesize a user + workspace pair so chat_search_index isn't
  // referencing nonexistent rows when other queries join on it.
  const userId = generateId("user");
  await pool.query(
    `INSERT INTO users (id, username, password_hash, email)
     VALUES (?, 'libidx', 'hash', 'libidx@example.com')`,
    [userId],
  );
  workspaceAId = generateId("workspace");
  workspaceASlug = `libidx-${workspaceAId.slice(-6)}`;
  await pool.query(
    `INSERT INTO workspaces (id, user_id, name, path) VALUES (?, ?, ?, ?)`,
    [workspaceAId, userId, "Libidx WS", workspaceASlug],
  );
  await ensureWorkspaceLayout(home, workspaceASlug);
});

afterAll(async () => {
  if (pool) await pool.end();
  if (home) await fs.rm(home, { recursive: true, force: true });
  if (dbPath) await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
});

async function writeWorkspaceFile(rel: string, body: string): Promise<void> {
  const abs = path.join(workspaceRootPath(home, workspaceASlug), rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, "utf-8");
}

async function searchRefIds(query: string): Promise<{ ref_id: string; kind: string }[]> {
  const { rows } = await pool.query<{ ref_id: string; kind: string }>(
    `SELECT ref_id, kind FROM chat_search_index WHERE body_lc LIKE ?`,
    [`%${query.toLowerCase()}%`],
  );
  return rows;
}

describe("indexLibraryFile", () => {
  it("indexes a markdown note as kind='note'", async () => {
    await writeWorkspaceFile("notes/kanban.md", "# Kanban\n\nSet up board with todo, doing, done.");
    await indexLibraryFile(pool, home, workspaceASlug, "notes/kanban.md");

    const hits = await searchRefIds("kanban");
    expect(hits.find((h) => h.ref_id === "notes/kanban.md")?.kind).toBe("note");
  });

  it("indexes a JSON file as kind='doc'", async () => {
    await writeWorkspaceFile("data/config.json", JSON.stringify({ feature: "owl" }, null, 2));
    await indexLibraryFile(pool, home, workspaceASlug, "data/config.json");

    const hits = await searchRefIds("owl");
    expect(hits.find((h) => h.ref_id === "data/config.json")?.kind).toBe("doc");
  });

  it("skips file types it does not recognize", async () => {
    await writeWorkspaceFile("media/cover.png", "binary content sentinel");
    await indexLibraryFile(pool, home, workspaceASlug, "media/cover.png");

    const hits = await searchRefIds("sentinel");
    expect(hits.find((h) => h.ref_id === "media/cover.png")).toBeUndefined();
  });
});

describe("indexAppManifest + indexFragmentManifest", () => {
  it("indexes an app manifest under kind='app' with name + description searchable", async () => {
    await writeWorkspaceFile(
      "todos.app/desk.app.json",
      JSON.stringify({
        name: "todos",
        description: "Manage daily tasks and pin them across chats.",
      }),
    );
    await indexAppManifest(pool, home, workspaceASlug, "todos.app");

    const hits = await searchRefIds("daily tasks");
    expect(hits.find((h) => h.ref_id === "todos.app")?.kind).toBe("app");
  });

  it("indexes a fragment manifest under kind='fragment' with params searchable", async () => {
    await writeWorkspaceFile(
      "todos.app/fragments/list/desk.fragment.json",
      JSON.stringify({
        name: "list",
        description: "Inline list view of todos.",
        params: { "filter?": "all | open | done" },
      }),
    );
    await indexFragmentManifest(pool, home, workspaceASlug, "todos.app/fragments/list");

    const hits = await searchRefIds("inline list");
    expect(hits.find((h) => h.ref_id === "todos.app/fragments/list")?.kind).toBe("fragment");

    // params are part of the indexed body, so they're searchable too.
    const paramHits = await searchRefIds("filter");
    expect(paramHits.find((h) => h.ref_id === "todos.app/fragments/list")).toBeTruthy();
  });

  it("indexes a degraded entry when validation fails (so the manifest is still findable)", async () => {
    await writeWorkspaceFile(
      "broken.app/desk.app.json",
      JSON.stringify({ name: "broken", description: "" }), // empty description rejected
    );
    await indexAppManifest(pool, home, workspaceASlug, "broken.app");

    // Searchable by name even though strict validation rejects the manifest.
    const hits = await searchRefIds("broken");
    expect(hits.find((h) => h.ref_id === "broken.app" && h.kind === "app")).toBeTruthy();
  });

  it("accepts unknown fields like displayName on a fragment manifest", async () => {
    await writeWorkspaceFile(
      "todos.app/fragments/note-editor/desk.fragment.json",
      JSON.stringify({
        name: "note-editor",
        displayName: "Note Editor", // extra field — strict() would reject
        description: "Edit a single note inline.",
        params: { note_id: "string" },
      }),
    );
    await indexFragmentManifest(
      pool,
      home,
      workspaceASlug,
      "todos.app/fragments/note-editor",
    );

    const hits = await searchRefIds("edit a single note");
    const hit = hits.find((h) => h.ref_id === "todos.app/fragments/note-editor");
    expect(hit?.kind).toBe("fragment");

    // params should still be searchable, proving full (not degraded) indexing.
    const paramHits = await searchRefIds("note_id");
    expect(paramHits.find((h) => h.ref_id === "todos.app/fragments/note-editor")).toBeTruthy();
  });

  it("indexes a degraded fragment entry when JSON is unparseable", async () => {
    await writeWorkspaceFile(
      "junk.app/fragments/garbage/desk.fragment.json",
      "{ this is not json", // unparseable
    );
    await indexFragmentManifest(
      pool,
      home,
      workspaceASlug,
      "junk.app/fragments/garbage",
    );

    // Falls back to the directory basename as the indexed name.
    const hits = await searchRefIds("garbage");
    expect(
      hits.find(
        (h) => h.ref_id === "junk.app/fragments/garbage" && h.kind === "fragment",
      ),
    ).toBeTruthy();
  });
});

describe("unindexLibraryPath", () => {
  it("removes prior index rows for a path", async () => {
    await writeWorkspaceFile("scratch.md", "# Scratch sentinel-xyz");
    await indexLibraryFile(pool, home, workspaceASlug, "scratch.md");
    expect((await searchRefIds("sentinel-xyz")).length).toBe(1);

    await unindexLibraryPath(pool, "scratch.md");
    expect((await searchRefIds("sentinel-xyz")).length).toBe(0);
  });
});

describe("backfillWorkspaceLibrary", () => {
  it("indexes every recognized file and manifest in the workspace", async () => {
    // Seed a fresh workspace.
    const slug = `libidx-bf-${Date.now().toString(36)}`;
    const wsId = generateId("workspace");
    await pool.query(
      `INSERT INTO workspaces (id, user_id, name, path) SELECT ?, user_id, ?, ? FROM workspaces LIMIT 1`,
      [wsId, "Libidx Backfill", slug],
    );
    await ensureWorkspaceLayout(home, slug);

    const root = workspaceRootPath(home, slug);
    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    await fs.writeFile(path.join(root, "notes/alpha.md"), "Alpha backfill content");
    await fs.writeFile(path.join(root, "data.json"), JSON.stringify({ k: "beta backfill" }));
    await fs.mkdir(path.join(root, "todos.app"), { recursive: true });
    await fs.writeFile(
      path.join(root, "todos.app/desk.app.json"),
      JSON.stringify({ name: "todos", description: "todos backfill app" }),
    );
    // Hidden directory should be skipped.
    await fs.mkdir(path.join(root, ".chats"), { recursive: true });
    await fs.writeFile(path.join(root, ".chats/secret.md"), "should-not-be-indexed");

    const stats = await backfillWorkspaceLibrary(pool, home, slug);
    expect(stats.filesIndexed).toBeGreaterThanOrEqual(2);
    expect(stats.manifestsIndexed).toBe(1);

    const { rows } = await pool.query<{ ref_id: string; kind: string }>(
      `SELECT ref_id, kind FROM chat_search_index WHERE workspace_slug = ?`,
      [slug],
    );
    const refs = new Set(rows.map((r) => r.ref_id));
    expect(refs.has("notes/alpha.md")).toBe(true);
    expect(refs.has("data.json")).toBe(true);
    expect(refs.has("todos.app")).toBe(true);
    // Hidden dir skipped.
    expect(refs.has(".chats/secret.md")).toBe(false);
  });

  it("does not double-index manifest files (no kind=doc twin for desk.app.json/desk.fragment.json)", async () => {
    const slug = `libidx-noDouble-${Date.now().toString(36)}`;
    const wsId = generateId("workspace");
    await pool.query(
      `INSERT INTO workspaces (id, user_id, name, path) SELECT ?, user_id, ?, ? FROM workspaces LIMIT 1`,
      [wsId, "Libidx NoDouble", slug],
    );
    await ensureWorkspaceLayout(home, slug);

    const root = workspaceRootPath(home, slug);
    await fs.mkdir(path.join(root, "todos.app/fragments/list"), { recursive: true });
    await fs.writeFile(
      path.join(root, "todos.app/desk.app.json"),
      JSON.stringify({ name: "todos", description: "Task list app." }),
    );
    await fs.writeFile(
      path.join(root, "todos.app/fragments/list/desk.fragment.json"),
      JSON.stringify({ name: "list", description: "Inline list view." }),
    );

    await backfillWorkspaceLibrary(pool, home, slug);

    const { rows } = await pool.query<{ ref_id: string; kind: string }>(
      `SELECT ref_id, kind FROM chat_search_index WHERE workspace_slug = ? ORDER BY ref_id, kind`,
      [slug],
    );
    // Each manifest path appears exactly once, only under its dedicated kind —
    // never as kind=doc.
    const docHits = rows.filter((r) => r.kind === "doc");
    expect(docHits.find((r) => r.ref_id === "todos.app/desk.app.json")).toBeUndefined();
    expect(
      docHits.find(
        (r) => r.ref_id === "todos.app/fragments/list/desk.fragment.json",
      ),
    ).toBeUndefined();

    // The manifest-aware path indexes the parent dir as the ref_id; that
    // entry should be there exactly once.
    const appHits = rows.filter((r) => r.kind === "app" && r.ref_id === "todos.app");
    expect(appHits).toHaveLength(1);
    const fragHits = rows.filter(
      (r) => r.kind === "fragment" && r.ref_id === "todos.app/fragments/list",
    );
    expect(fragHits).toHaveLength(1);
  });
});
