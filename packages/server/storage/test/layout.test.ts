import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ensureLayout } from "../src/layout.js";

let home: string;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-layout-test-"));
});

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("ensureLayout", () => {
  it("creates the workspace root and the hidden .chats subtree", async () => {
    await ensureLayout(home);

    const root = path.join(home, "Desk", "workspaces", "desk");
    const stat = await fs.stat(root);
    expect(stat.isDirectory()).toBe(true);

    // The only pre-created subtree is the hidden chat conversation root.
    // User-visible folders live directly at the workspace root and are
    // created on-demand.
    const chatsStat = await fs.stat(path.join(root, ".chats"));
    expect(chatsStat.isDirectory()).toBe(true);

    // .tmp and .trash exist outside the workspace (they're global).
    const tmpStat = await fs.stat(path.join(home, "Desk", ".tmp"));
    expect(tmpStat.isDirectory()).toBe(true);
    const trashStat = await fs.stat(path.join(home, "Desk", ".trash"));
    expect(trashStat.isDirectory()).toBe(true);
  });

  it("is idempotent", async () => {
    await ensureLayout(home);
    await ensureLayout(home);

    const root = path.join(home, "Desk", "workspaces", "desk");
    const stat = await fs.stat(root);
    expect(stat.isDirectory()).toBe(true);
  });
});
