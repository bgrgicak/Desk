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
  it("creates the workspace directory tree", async () => {
    await ensureLayout(home);

    const root = path.join(home, "Desk", "workspaces", "desk");
    const stat = await fs.stat(root);
    expect(stat.isDirectory()).toBe(true);

    for (const dir of ["files", "chats", "library"]) {
      const s = await fs.stat(path.join(root, dir));
      expect(s.isDirectory()).toBe(true);
    }

    // .tmp dir exists
    const tmpStat = await fs.stat(path.join(home, "Desk", ".tmp"));
    expect(tmpStat.isDirectory()).toBe(true);
  });

  it("is idempotent", async () => {
    await ensureLayout(home);
    await ensureLayout(home);

    const root = path.join(home, "Desk", "workspaces", "desk");
    const stat = await fs.stat(root);
    expect(stat.isDirectory()).toBe(true);
  });
});
