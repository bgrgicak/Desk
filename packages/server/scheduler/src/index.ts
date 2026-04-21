export { createRunManager } from "./runs.js";
export type { EnqueueRunInput, RunManagerOptions } from "./runs.js";
export { createAdapter, createMemoryAdapter } from "./scheduleAdapter.js";
export type { ScheduleAdapter } from "./scheduleAdapter.js";
export { scheduleAiNote, cancelAiNote } from "./ai-notes.js";
export { reconcile } from "./reconcile.js";

// Re-export RunManager type so downstream packages can type it without
// reaching into createRunManager's ReturnType.
import type { createRunManager } from "./runs.js";
export type RunManager = ReturnType<typeof createRunManager>;

// Standalone function re-exports matching the plan's public surface.
// These accept a RunManager as first arg and delegate to its methods.

export function enqueueRun(
  runManager: RunManager,
  input: import("./runs.js").EnqueueRunInput,
) {
  return runManager.enqueueRun(input);
}

export function executeRun(
  runManager: RunManager,
  runId: string,
  prompt: string,
) {
  return runManager.executeRun(runId, prompt);
}

export function cancelRun(
  runManager: RunManager,
  runId: string,
) {
  return runManager.cancelRun(runId);
}
