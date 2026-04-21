import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { generateId } from "@desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as scheduledJobs from "../../src/queries/scheduledJobs.js";

let pool: pg.Pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("scheduledJobs queries", () => {
  const jobId = generateId("scheduledJob");

  it("inserts a scheduled job", async () => {
    const job = await scheduledJobs.insert(pool, {
      id: jobId,
      kind: "once",
      spec: { type: "once", onceAt: new Date().toISOString() },
    });
    expect(job.id).toBe(jobId);
    expect(job.kind).toBe("once");
    expect(job.active).toBe(true);
  });

  it("finds by id", async () => {
    const job = await scheduledJobs.findById(pool, jobId);
    expect(job).not.toBeNull();
    expect(job!.kind).toBe("once");
  });

  it("lists active jobs", async () => {
    const list = await scheduledJobs.listActive(pool);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it("updates a job", async () => {
    const updated = await scheduledJobs.update(pool, jobId, {
      atJobId: "42",
      nextRunAt: new Date("2030-01-01"),
    });
    expect(updated).not.toBeNull();
    expect(updated!.atJobId).toBe("42");
  });

  it("cancels a job", async () => {
    const ok = await scheduledJobs.cancel(pool, jobId);
    expect(ok).toBe(true);
    const job = await scheduledJobs.findById(pool, jobId);
    expect(job!.active).toBe(false);
  });

  it("lists for reconcile", async () => {
    // The cancelled job has an at_job_id but active=false, so it shouldn't appear
    const list = await scheduledJobs.listForReconcile(pool);
    const found = list.find((j) => j.id === jobId);
    expect(found).toBeUndefined();
  });
});
