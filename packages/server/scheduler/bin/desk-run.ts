#!/usr/bin/env node

/**
 * desk-run <jobId>
 *
 * Binary invoked by `at` and `crontab`. Loads the scheduled job,
 * creates a run, and executes it synchronously.
 * Exits with the run's exit code so at/cron logs reflect failures.
 */

import { createPool } from "@desk/db";
import { queries } from "@desk/db";
import { createRunManager } from "../src/runs.js";

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("Usage: desk-run <jobId>");
    process.exit(1);
  }

  const pool = createPool();

  try {
    const job = await queries.scheduledJobs.findById(pool, jobId);
    if (!job) {
      console.error(`Job not found: ${jobId}`);
      process.exit(1);
    }

    if (!job.active) {
      console.log(`Job ${jobId} is inactive, skipping`);
      process.exit(0);
    }

    const runManager = createRunManager({ pool });
    const prompt = `Execute scheduled job ${jobId}`;

    // Create the run row first
    const run = await runManager.enqueueRun({
      chatId: job.chatId,
      prompt,
      mode: "immediate",
    });

    console.log(`Run ${run.id} enqueued for job ${jobId}`);

    // Wait for execution to finish and retrieve the exit code
    // The immediate mode fires executeRun in the background, so we need to
    // poll until the run completes.
    const maxWaitMs = 10 * 60 * 1000; // 10 minutes
    const pollIntervalMs = 500;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      const updated = await queries.runs.findById(pool, run.id);
      if (updated && (updated.state === "succeeded" || updated.state === "failed" || updated.state === "cancelled")) {
        const exitCode = updated.exitCode ?? (updated.state === "succeeded" ? 0 : 1);
        process.exit(exitCode);
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    console.error(`Run ${run.id} timed out after ${maxWaitMs / 1000}s`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
