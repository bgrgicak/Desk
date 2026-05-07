import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  ensureLayout,
  ensureWorkspaceLayout,
  materializeSummary,
  snapshotSummary,
  snapshotAndReplaceSummary,
  listSummaryHistory,
  summaryStorageDir,
  summaryHistoryDir,
} from "../src/index.js";

const SLUG = "alpha";
// Synthetic IDs that satisfy the prefix validators.
const CHAT_ID = "cht_summary_test_chat";
const MSG_ID = "msg_summary_test_msg";

let home: string;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-summary-history-"));
  await ensureLayout(home);
  await ensureWorkspaceLayout(home, SLUG);
});

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("materializeSummary", () => {
  it("writes the body to <chat>/notes/<messageId>.md atomically", async () => {
    const written = await materializeSummary(home, SLUG, CHAT_ID, MSG_ID, "first body");
    expect(written).toBe(path.join(summaryStorageDir(home, SLUG, CHAT_ID), `${MSG_ID}.md`));

    const body = await fs.readFile(written, "utf-8");
    expect(body).toBe("first body");
  });

  it("leaves no temp files behind on a successful write", async () => {
    await materializeSummary(home, SLUG, CHAT_ID, MSG_ID, "second body");
    const dir = summaryStorageDir(home, SLUG, CHAT_ID);
    const entries = await fs.readdir(dir);
    const tmps = entries.filter((e) => e.endsWith(".tmp") || e.startsWith("."));
    // .history is allowed; nothing else hidden/temp.
    expect(tmps.filter((e) => e !== ".history")).toEqual([]);
  });
});

describe("snapshotSummary", () => {
  it("writes a timestamp-prefixed history entry the listSummaryHistory query can find", async () => {
    await snapshotSummary(home, SLUG, CHAT_ID, MSG_ID, "history v1");
    await new Promise((r) => setTimeout(r, 5));
    await snapshotSummary(home, SLUG, CHAT_ID, MSG_ID, "history v2");

    const versions = await listSummaryHistory(home, SLUG, CHAT_ID, MSG_ID);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    // Newest first.
    expect(versions[0].body).toBe("history v2");
  });
});

describe("snapshotAndReplaceSummary — atomic under concurrent fires", () => {
  const RACE_CHAT = "cht_race_chat";
  const RACE_MSG = "msg_race_msg";

  it("serializes two concurrent fires so the intermediate body lands in history, not lost", async () => {
    // Seed the materialized file.
    await materializeSummary(home, SLUG, RACE_CHAT, RACE_MSG, "v0");

    // Two concurrent fires writing v1 and v2. Without per-chat
    // serialization, both would read "v0" as the previous body and the
    // intermediate write (whichever finished first) would be lost — only
    // v0 would ever appear in history. With serialization, the second
    // fire reads the first fire's freshly materialized body and snapshots
    // it, so history has BOTH v0 and the intermediate winner.
    const [, ] = await Promise.all([
      snapshotAndReplaceSummary(home, SLUG, RACE_CHAT, RACE_MSG, "v1"),
      snapshotAndReplaceSummary(home, SLUG, RACE_CHAT, RACE_MSG, "v2"),
    ]);

    const finalBody = await fs.readFile(
      path.join(summaryStorageDir(home, SLUG, RACE_CHAT), `${RACE_MSG}.md`),
      "utf-8",
    );
    // One of v1 or v2 wins as the materialized body.
    expect(["v1", "v2"]).toContain(finalBody);

    const history = await listSummaryHistory(home, SLUG, RACE_CHAT, RACE_MSG);
    const bodies = history.map((h) => h.body);

    // The seeded v0 must be in history.
    expect(bodies).toContain("v0");
    // The intermediate winner must also be in history (the loser of the
    // final-state race becomes history because the second writer
    // snapshotted it before overwriting it).
    const intermediate = finalBody === "v1" ? "v2" : "v1";
    expect(bodies).toContain(intermediate);
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it("skips snapshot on the first write when no prior materialized file exists", async () => {
    const FRESH_CHAT = "cht_fresh_chat";
    const FRESH_MSG = "msg_fresh_msg";
    const result = await snapshotAndReplaceSummary(
      home,
      SLUG,
      FRESH_CHAT,
      FRESH_MSG,
      "first ever",
    );
    expect(result.snapshotPath).toBeNull();
    expect(result.materializedPath).toContain(`${FRESH_MSG}.md`);

    const historyDir = summaryHistoryDir(home, SLUG, FRESH_CHAT);
    const exists = await fs.stat(historyDir).catch(() => null);
    if (exists) {
      const entries = await fs.readdir(historyDir);
      expect(entries.filter((e) => !e.endsWith(".tmp"))).toEqual([]);
    }
  });
});
