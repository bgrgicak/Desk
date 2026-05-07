export { createRunManager } from "./runs.js";
export type { FireMessageOptions, RunManagerOptions } from "./runs.js";

import type { createRunManager } from "./runs.js";
export type RunManager = ReturnType<typeof createRunManager>;
