import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  ensureLayout,
  ensureWorkspaceLayout,
  ensureUserMemoryLayout,
  ensureWorkspaceMemoryLayout,
  migrateLegacyWorkspaceLayout,
  userMemoryDir,
  userMemoryIndexPath,
  userMemoryTopicPath,
  userJournalDir,
  userJournalPath,
  workspaceMemoryDir,
  workspaceMemoryIndexPath,
  workspaceMemoryTopicPath,
  workspaceJournalDir,
  workspaceJournalPath,
} from "../src/layout.js";

let home: string;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-layout-test-"));
});

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("ensureLayout", () => {
  it("creates the global Desk directories without any workspace subtree", async () => {
    await ensureLayout(home);

    // Global dirs exist regardless of whether any workspaces were created.
    const tmpStat = await fs.stat(path.join(home, ".tmp"));
    expect(tmpStat.isDirectory()).toBe(true);
    const trashStat = await fs.stat(path.join(home, ".trash"));
    expect(trashStat.isDirectory()).toBe(true);
    // The legacy `workspaces/` parent is no longer part of the layout —
    // workspaces sit directly under $DESK_HOME.
    const legacy = await fs.stat(path.join(home, "workspaces")).catch(() => null);
    expect(legacy).toBeNull();
  });

  it("is idempotent", async () => {
    await ensureLayout(home);
    await ensureLayout(home);

    const tmpStat = await fs.stat(path.join(home, ".tmp"));
    expect(tmpStat.isDirectory()).toBe(true);
  });
});

describe("ensureWorkspaceLayout", () => {
  it("creates the workspace root and the hidden .chats subtree for a given slug", async () => {
    await ensureLayout(home);
    await ensureWorkspaceLayout(home, "desk");

    const root = path.join(home, "desk");
    const stat = await fs.stat(root);
    expect(stat.isDirectory()).toBe(true);

    const chatsStat = await fs.stat(path.join(root, ".chats"));
    expect(chatsStat.isDirectory()).toBe(true);
  });

  it("isolates two workspaces under distinct slug directories", async () => {
    await ensureLayout(home);
    await ensureWorkspaceLayout(home, "alpha");
    await ensureWorkspaceLayout(home, "beta");

    const alpha = await fs.stat(path.join(home, "alpha"));
    const beta = await fs.stat(path.join(home, "beta"));
    expect(alpha.isDirectory()).toBe(true);
    expect(beta.isDirectory()).toBe(true);
  });
});

describe("memory path helpers", () => {
  it("resolves user memory paths under $DESK_HOME/.memory/", () => {
    expect(userMemoryDir("/h")).toBe(path.join("/h", ".memory"));
    expect(userMemoryIndexPath("/h")).toBe(path.join("/h", ".memory", "memory.md"));
    expect(userJournalDir("/h")).toBe(path.join("/h", ".memory", "journal"));
  });

  it("resolves user memory topic and journal files", () => {
    expect(userMemoryTopicPath("/h", "build-tools.md"))
      .toBe(path.join("/h", ".memory", "build-tools.md"));
    expect(userJournalPath("/h", "2026-05-06"))
      .toBe(path.join("/h", ".memory", "journal", "2026-05-06.md"));
  });

  it("resolves workspace memory paths under <workspace>/.memory/", () => {
    expect(workspaceMemoryDir("/h", "alpha"))
      .toBe(path.join("/h", "alpha", ".memory"));
    expect(workspaceMemoryIndexPath("/h", "alpha"))
      .toBe(path.join("/h", "alpha", ".memory", "workspace.md"));
    expect(workspaceMemoryTopicPath("/h", "alpha", "naming.md"))
      .toBe(path.join("/h", "alpha", ".memory", "naming.md"));
    expect(workspaceJournalDir("/h", "alpha"))
      .toBe(path.join("/h", "alpha", ".memory", "journal"));
    expect(workspaceJournalPath("/h", "alpha", "2026-05-06"))
      .toBe(path.join("/h", "alpha", ".memory", "journal", "2026-05-06.md"));
  });

  it("rejects topic filenames that escape the memory directory", () => {
    expect(() => userMemoryTopicPath("/h", "../etc/passwd")).toThrow();
    expect(() => userMemoryTopicPath("/h", "sub/dir.md")).toThrow();
    expect(() => userMemoryTopicPath("/h", ".hidden.md")).toThrow();
    expect(() => userMemoryTopicPath("/h", "no-extension")).toThrow();
    expect(() => userMemoryTopicPath("/h", "")).toThrow();
    expect(() => workspaceMemoryTopicPath("/h", "alpha", "../escape.md")).toThrow();
  });

  it("rejects malformed journal dates", () => {
    expect(() => userJournalPath("/h", "2026-5-6")).toThrow();
    expect(() => userJournalPath("/h", "yesterday")).toThrow();
    expect(() => userJournalPath("/h", "2026-05-06.md")).toThrow();
    expect(() => workspaceJournalPath("/h", "alpha", "")).toThrow();
  });

  it("rejects bad slugs through workspace memory paths", () => {
    expect(() => workspaceMemoryDir("/h", "../bad")).toThrow();
    expect(() => workspaceMemoryIndexPath("/h", ".dotfile")).toThrow();
  });
});

describe("ensureUserMemoryLayout", () => {
  let local: string;

  beforeAll(async () => {
    local = await fs.mkdtemp(path.join(os.tmpdir(), "desk-memory-user-"));
  });

  afterAll(async () => {
    await fs.rm(local, { recursive: true, force: true });
  });

  it("creates the user memory tree with an index skeleton and journal directory", async () => {
    await ensureUserMemoryLayout(local);

    const indexStat = await fs.stat(userMemoryIndexPath(local));
    expect(indexStat.isFile()).toBe(true);
    const journalStat = await fs.stat(userJournalDir(local));
    expect(journalStat.isDirectory()).toBe(true);

    const body = await fs.readFile(userMemoryIndexPath(local), "utf-8");
    expect(body).toMatch(/User memory/);
  });

  it("does not overwrite an existing index", async () => {
    await ensureUserMemoryLayout(local);
    await fs.writeFile(userMemoryIndexPath(local), "# Custom user index\n", "utf-8");
    await ensureUserMemoryLayout(local);

    const body = await fs.readFile(userMemoryIndexPath(local), "utf-8");
    expect(body).toBe("# Custom user index\n");
  });

  it("is invoked transitively by ensureLayout", async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), "desk-memory-bootstrap-"));
    try {
      await ensureLayout(fresh);
      const stat = await fs.stat(userMemoryIndexPath(fresh));
      expect(stat.isFile()).toBe(true);
    } finally {
      await fs.rm(fresh, { recursive: true, force: true });
    }
  });
});

describe("ensureWorkspaceMemoryLayout", () => {
  let local: string;

  beforeAll(async () => {
    local = await fs.mkdtemp(path.join(os.tmpdir(), "desk-memory-ws-"));
  });

  afterAll(async () => {
    await fs.rm(local, { recursive: true, force: true });
  });

  it("creates the workspace memory tree with an index skeleton and journal directory", async () => {
    await ensureLayout(local);
    await ensureWorkspaceLayout(local, "alpha");

    const indexStat = await fs.stat(workspaceMemoryIndexPath(local, "alpha"));
    expect(indexStat.isFile()).toBe(true);
    const journalStat = await fs.stat(workspaceJournalDir(local, "alpha"));
    expect(journalStat.isDirectory()).toBe(true);

    const body = await fs.readFile(workspaceMemoryIndexPath(local, "alpha"), "utf-8");
    expect(body).toMatch(/Workspace memory/);
  });

  it("does not overwrite an existing workspace index", async () => {
    await ensureLayout(local);
    await ensureWorkspaceLayout(local, "beta");
    await fs.writeFile(
      workspaceMemoryIndexPath(local, "beta"),
      "# Custom workspace index\n",
      "utf-8",
    );
    await ensureWorkspaceMemoryLayout(local, "beta");

    const body = await fs.readFile(workspaceMemoryIndexPath(local, "beta"), "utf-8");
    expect(body).toBe("# Custom workspace index\n");
  });
});

describe("migrateLegacyWorkspaceLayout", () => {
  let local: string;

  beforeEach(async () => {
    local = await fs.mkdtemp(path.join(os.tmpdir(), "desk-migrate-"));
  });

  afterEach(async () => {
    await fs.rm(local, { recursive: true, force: true });
  });

  it("returns zero counts when no legacy parent exists", async () => {
    const res = await migrateLegacyWorkspaceLayout(local);
    expect(res).toEqual({ migrated: 0, skipped: 0, conflicts: [] });
  });

  it("moves each legacy workspace up one level and removes the parent", async () => {
    const legacy = path.join(local, "workspaces");
    await fs.mkdir(path.join(legacy, "alpha", ".chats"), { recursive: true });
    await fs.writeFile(path.join(legacy, "alpha", "note.md"), "alpha-body", "utf-8");
    await fs.mkdir(path.join(legacy, "beta"), { recursive: true });
    await fs.writeFile(path.join(legacy, "beta", "data.txt"), "beta-body", "utf-8");

    const res = await migrateLegacyWorkspaceLayout(local);
    expect(res.migrated).toBe(2);
    expect(res.skipped).toBe(0);
    expect(res.conflicts).toEqual([]);

    // New flat layout has the workspace contents.
    const alphaNote = await fs.readFile(path.join(local, "alpha", "note.md"), "utf-8");
    expect(alphaNote).toBe("alpha-body");
    const betaData = await fs.readFile(path.join(local, "beta", "data.txt"), "utf-8");
    expect(betaData).toBe("beta-body");

    // Legacy parent is gone after a clean migration.
    const legacyStat = await fs.stat(legacy).catch(() => null);
    expect(legacyStat).toBeNull();
  });

  it("is idempotent — second invocation is a no-op", async () => {
    await fs.mkdir(path.join(local, "workspaces", "alpha"), { recursive: true });
    await fs.writeFile(path.join(local, "workspaces", "alpha", "x.txt"), "x", "utf-8");

    const first = await migrateLegacyWorkspaceLayout(local);
    expect(first.migrated).toBe(1);

    const second = await migrateLegacyWorkspaceLayout(local);
    expect(second).toEqual({ migrated: 0, skipped: 0, conflicts: [] });

    const body = await fs.readFile(path.join(local, "alpha", "x.txt"), "utf-8");
    expect(body).toBe("x");
  });

  it("skips entries whose destination already exists and reports a conflict", async () => {
    await fs.mkdir(path.join(local, "workspaces", "alpha"), { recursive: true });
    await fs.writeFile(path.join(local, "workspaces", "alpha", "old.txt"), "old", "utf-8");
    // Pre-existing flat directory at the destination.
    await fs.mkdir(path.join(local, "alpha"), { recursive: true });
    await fs.writeFile(path.join(local, "alpha", "new.txt"), "new", "utf-8");

    const res = await migrateLegacyWorkspaceLayout(local);
    expect(res.migrated).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.conflicts).toEqual(["alpha"]);

    // Source was left in place.
    const old = await fs.readFile(path.join(local, "workspaces", "alpha", "old.txt"), "utf-8");
    expect(old).toBe("old");
    // Destination is untouched.
    const newBody = await fs.readFile(path.join(local, "alpha", "new.txt"), "utf-8");
    expect(newBody).toBe("new");
  });

  it("skips invalid/reserved slugs in the legacy parent", async () => {
    // Dot-prefixed and otherwise-invalid names left over in `workspaces/`
    // (rare but possible) must not blow up the migration.
    await fs.mkdir(path.join(local, "workspaces", ".garbage"), { recursive: true });
    await fs.mkdir(path.join(local, "workspaces", "alpha"), { recursive: true });

    const res = await migrateLegacyWorkspaceLayout(local);
    expect(res.migrated).toBe(1);
    expect(res.conflicts).toContain(".garbage");

    const moved = await fs.stat(path.join(local, "alpha")).catch(() => null);
    expect(moved?.isDirectory()).toBe(true);
  });
});
