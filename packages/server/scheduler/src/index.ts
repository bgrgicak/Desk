export { createRunManager } from "./runs.js";
export type { FireMessageOptions, RunManagerOptions } from "./runs.js";

import type { createRunManager } from "./runs.js";
export type RunManager = ReturnType<typeof createRunManager>;

export {
  runDailyReflection,
  runWorkspaceReflection,
  startDailyReflection,
  ensureDailyReflectionTasks,
  DAILY_REFLECTION_CRON,
  DAILY_REFLECTION_TITLE,
  yesterdayDateLocal,
} from "./reflection.js";
export type {
  WorkspaceReflectionInput,
  ReflectionResult,
  ReflectFn,
  RunDailyReflectionOptions,
  DailyReflectionScheduleOptions,
  EnsureDailyReflectionTasksOptions,
} from "./reflection.js";

export { detectCrashedOrphans } from "./orphanRecovery.js";
export type { OrphanCandidate, CrashedOrphan } from "./orphanRecovery.js";
