import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ensureLayout, ensureWorkspaceLayout } from "../src/layout.js";

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
    const tmpStat = await fs.stat(path.join(home, "Desk", ".tmp"));
    expect(tmpStat.isDirectory()).toBe(true);
    const trashStat = await fs.stat(path.join(home, "Desk", ".trash"));
    expect(trashStat.isDirectory()).toBe(true);
    const wsRoot = await fs.stat(path.join(home, "Desk", "workspaces"));
    expect(wsRoot.isDirectory()).toBe(true);
  });

  it("is idempotent", async () => {
    await ensureLayout(home);
    await ensureLayout(home);

    const tmpStat = await fs.stat(path.join(home, "Desk", ".tmp"));
    expect(tmpStat.isDirectory()).toBe(true);
  });
});

describe("ensureWorkspaceLayout", () => {
  it("creates the workspace root and the hidden .chats subtree for a given slug", async () => {
    await ensureLayout(home);
    await ensureWorkspaceLayout(home, "desk");

    const root = path.join(home, "Desk", "workspaces", "desk");
    const stat = await fs.stat(root);
    expect(stat.isDirectory()).toBe(true);

    const chatsStat = await fs.stat(path.join(root, ".chats"));
    expect(chatsStat.isDirectory()).toBe(true);
  });

  it("isolates two workspaces under distinct slug directories", async () => {
    await ensureLayout(home);
    await ensureWorkspaceLayout(home, "alpha");
    await ensureWorkspaceLayout(home, "beta");

    const alpha = await fs.stat(path.join(home, "Desk", "workspaces", "alpha"));
    const beta = await fs.stat(path.join(home, "Desk", "workspaces", "beta"));
    expect(alpha.isDirectory()).toBe(true);
    expect(beta.isDirectory()).toBe(true);
  });
});
