import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureLayout, enforceLogRetention, trashDir } from "../src/index.js";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-log-retention-"));
  await ensureLayout(home);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function seedLogs(chatId: string, count: number): Promise<string[]> {
  const dir = path.join(home, "desk", ".chats", chatId, "logs");
  await fs.mkdir(dir, { recursive: true });
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `msg_${String(i).padStart(3, "0")}.log`;
    const abs = path.join(dir, name);
    await fs.writeFile(abs, `log ${i}`);
    // Stagger mtime so ordering is deterministic.
    const t = new Date(2026, 0, 1, 0, 0, i);
    await fs.utimes(abs, t, t);
    names.push(name);
  }
  return names;
}

describe("enforceLogRetention", () => {
  it("no-op when file count is below the cap", async () => {
    await seedLogs("cht_under_cap_________", 3);
    const res = await enforceLogRetention(home, 5);
    expect(res.evicted).toBe(0);
  });

  it("evicts the oldest files down to cap and moves them to trash", async () => {
    const chatId = "cht_over_cap_1________";
    await seedLogs(chatId, 10);

    const res = await enforceLogRetention(home, 4);
    expect(res.evicted).toBe(6);

    const remaining = await fs.readdir(
      path.join(home, "desk", ".chats", chatId, "logs"),
    );
    expect(remaining.length).toBe(4);
    // Survivors are the 6 newest (indices 4..9).
    expect(remaining.sort()).toEqual(["msg_004.log", "msg_005.log", "msg_006.log", "msg_007.log", "msg_008.log", "msg_009.log"].slice(-4));

    const trashed = await fs.readdir(path.join(trashDir(home), "logs"));
    expect(trashed.length).toBe(6);
  });

  it("applies the cap per chat, not globally", async () => {
    await seedLogs("cht_independent_a_____", 5);
    await seedLogs("cht_independent_b_____", 5);

    const res = await enforceLogRetention(home, 3);
    expect(res.evicted).toBe(4); // 2 from each chat
  });

  it("returns zero when the chats directory does not exist", async () => {
    // Fresh tmpdir without ensureLayout.
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "desk-log-retention-empty-"));
    try {
      const res = await enforceLogRetention(other, 100);
      expect(res).toEqual({ scanned: 0, evicted: 0 });
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});
