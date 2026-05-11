export {
  createOrReuse,
  stopSandbox,
  ensureImage,
  auditSandboxMounts,
  pruneDriftedContainers,
  sandboxImage,
  providerKeyEnv,
  classifyResourceError,
  growSandboxForResourceError,
  reapIdleSandboxes,
  killClaimedRunsInContainers,
  _resetGrowthStateForTest,
} from "./docker.js";
export type { SandboxHandle, SandboxBindDrift, ResourceFailureKind, GrowthResult } from "./docker.js";
export { detectEngine, ContainerRuntimeUnavailableError } from "./engine.js";
export type {
  Engine,
  EngineName,
  RunSpec,
  ContainerInfo,
  ExecSpec,
  ExecHandle,
  BindMount,
} from "./engine.js";
export {
  projectMounts,
  teardownMounts,
  activeRunCount,
  containerBinds,
  buildDefaultMountPlan,
  bindsFromPlan,
  SANDBOX_HOME,
} from "./mounts.js";
export type { MountSet, MountPlan, MountPlanEntry } from "./mounts.js";
export { execRun, cancelRun } from "./opencode.js";
export type { ExecRunOptions } from "./opencode.js";
export { renderAgentFile, writeAgentFile } from "./agentFile.js";
export type { AgentFileInput } from "./agentFile.js";
export { renderPromptBody, loadAndSub } from "./prompt.js";
export type { RenderPromptInput } from "./prompt.js";
export {
  writeDeskSkillFiles,
  writeGoalSkillFiles,
  DESK_SKILLS_SANDBOX_DIR,
  GOAL_SKILLS_SANDBOX_DIR,
  DESK_SKILL_PREFIX,
  DESK_GOAL_SKILL_PREFIX,
  goalSkillName,
} from "./goalSkills.js";
export { createDriver } from "./driver.js";
export type { SandboxDriver, RunOptions, LogEvent, ExecResult } from "./driver.js";
export { execInSandbox } from "./sandboxExec.js";
export type { ExecInSandboxOptions, ExecInSandboxResult } from "./sandboxExec.js";
export { listModels, parseModelsOutput, SandboxExecError } from "./models.js";
export type { ModelRef, ListModelsOptions } from "./models.js";
export {
  estimateStringTokens,
  estimateMessagesTokens,
  transcriptExceedsBudget,
} from "./tokenize.js";
export type { TokenizableMessage } from "./tokenize.js";
export {
  productionReflectWorkspace,
} from "./reflectFn.js";
export {
  LOCAL_SOURCES,
  LOCAL_SOURCE_KINDS,
  detectLocalSource,
  listLocalSourceStatuses,
  loadLocalSourceEnv,
  resolveLocalSourceEnv,
} from "./localSources/index.js";
export type {
  LocalSource,
  LocalSourceKind,
  LocalSourceStatus,
} from "./localSources/types.js";
