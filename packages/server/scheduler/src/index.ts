export { createRunManager } from "./runs.js";
export type { FireMessageOptions, RunManagerOptions } from "./runs.js";

import type { createRunManager } from "./runs.js";
export type RunManager = ReturnType<typeof createRunManager>;

export {
  runDailyReflection,
  runWorkspaceReflection,
  startDailyReflection,
  yesterdayDateLocal,
} from "./reflection.js";
export type {
  WorkspaceReflectionInput,
  ReflectionResult,
  ReflectFn,
  RunDailyReflectionOptions,
  DailyReflectionScheduleOptions,
} from "./reflection.js";
