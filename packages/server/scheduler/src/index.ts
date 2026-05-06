export { createRunManager } from "./runs.js";
export type { FireMessageOptions, RunManagerOptions } from "./runs.js";

import type { createRunManager } from "./runs.js";
export type RunManager = ReturnType<typeof createRunManager>;

export {
  runDailyReflection,
  runWorkspaceReflection,
  runUserReflectionRollup,
  startDailyReflection,
  yesterdayDateUTC,
} from "./reflection.js";
export type {
  WorkspaceReflectionInput,
  UserReflectionInput,
  ReflectionResult,
  ReflectFn,
  RunDailyReflectionOptions,
  DailyReflectionScheduleOptions,
} from "./reflection.js";
