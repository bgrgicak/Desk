import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { generateId } from "@desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as runs from "../../src/queries/runs.js";

let pool: pg.Pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("runs queries", () => {
  const runId = generateId("run");

  it("inserts a run", async () => {
    const run = await runs.insert(pool, { id: runId });
    expect(run.id).toBe(runId);
    expect(run.state).toBe("pending");
  });

  it("finds by id", async () => {
    const run = await runs.findById(pool, runId);
    expect(run).not.toBeNull();
    expect(run!.state).toBe("pending");
  });

  it("updates state to running", async () => {
    const run = await runs.updateState(pool, runId, { state: "running" });
    expect(run).not.toBeNull();
    expect(run!.state).toBe("running");
    expect(run!.startedAt).toBeDefined();
  });

  it("updates state to succeeded with exit code", async () => {
    const run = await runs.updateState(pool, runId, { state: "succeeded", exitCode: 0 });
    expect(run).not.toBeNull();
    expect(run!.state).toBe("succeeded");
    expect(run!.exitCode).toBe(0);
    expect(run!.finishedAt).toBeDefined();
  });

  it("lists recent runs", async () => {
    const list = await runs.listRecent(pool);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });
});
