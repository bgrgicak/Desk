import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { generateId } from "@desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as runs from "../../src/queries/runs.js";
import * as runEvents from "../../src/queries/runEvents.js";

let pool: pg.Pool;
let runId: string;

beforeAll(async () => {
  pool = await setupTestDb();
  runId = generateId("run");
  await runs.insert(pool, { id: runId });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("runEvents queries", () => {
  it("appends an event", async () => {
    const ev = await runEvents.append(pool, {
      id: generateId("runEvent"),
      runId,
      seq: 0,
      kind: "stdout",
      payload: { text: "hello" },
    });
    expect(ev.runId).toBe(runId);
    expect(ev.seq).toBe(0);
    expect(ev.kind).toBe("stdout");
  });

  it("lists by run with cursor pagination", async () => {
    for (let i = 1; i <= 5; i++) {
      await runEvents.append(pool, {
        id: generateId("runEvent"),
        runId,
        seq: i,
        kind: "stdout",
        payload: { text: `line ${i}` },
      });
    }

    const page1 = await runEvents.listByRun(pool, runId, { limit: 3 });
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await runEvents.listByRun(pool, runId, { cursor: page1.nextCursor, limit: 3 });
    expect(page2.items.length).toBeGreaterThanOrEqual(1);
  });

  it("cascades delete when run is deleted", async () => {
    await pool.query("DELETE FROM runs WHERE id = $1", [runId]);
    const result = await runEvents.listByRun(pool, runId);
    expect(result.items).toHaveLength(0);
  });
});
