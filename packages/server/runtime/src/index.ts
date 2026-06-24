export {
  createOrReuse,
  stopSandbox,
  stopRunningSandboxes,
  ensureImage,
  auditSandboxMounts,
  pruneDriftedContainers,
  sandboxImage,
  providerKeyEnv,
  rawSandboxCredentialEnvEnabled,
  classifyResourceError,
  growSandboxForResourceError,
  reapIdleSandboxes,
  softReapIdleDaemons,
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
  buildWorkspaceMountPlan,
  bindsFromPlan,
  SANDBOX_HOME,
  SKILLS_SANDBOX_MOUNT_DIR,
  APPS_SANDBOX_MOUNT_DIR,
  skillsHostDir,
  appsHostDir,
} from "./mounts.js";
export type { MountSet, MountPlan, MountPlanEntry } from "./mounts.js";
export { writeBuiltinApps, BUILTIN_APPS_MANIFEST_FILE } from "./builtinApps.js";
export { execRun, cancelRun } from "./execRun.js";
export type { ExecRunOptions } from "./execRun.js";
export { renderAgentFile, writeAgentFile } from "./agentFile.js";
export type { AgentFileInput } from "./agentFile.js";
export { renderPromptBody, loadAndSub } from "./prompt.js";
export type { RenderPromptInput } from "./prompt.js";
export {
  writeRoomySkillFiles,
  writeGoalSkillFiles,
  ROOMY_SKILLS_SANDBOX_DIR,
  GOAL_SKILLS_SANDBOX_DIR,
  ROOMY_SKILL_PREFIX,
  ROOMY_GOAL_SKILL_PREFIX,
  goalSkillName,
} from "./goalSkills.js";
export { createDriver, buildDaemonEnv, buildPiEnv, hasActiveRunForContainer, isContainerGoneError } from "./driver.js";
export type { SandboxDriver, RunOptions, LogEvent, ExecResult } from "./driver.js";
export { refreshSandboxConnections } from "./connectionRefresh.js";
export type {
  RefreshSandboxConnectionsOpts,
  RefreshSandboxConnectionsResult,
} from "./connectionRefresh.js";
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
  resolveAvailableLocalSourceEnv,
} from "./localSources/index.js";
export type {
  LocalSource,
  LocalSourceKind,
  LocalSourceStatus,
} from "./localSources/types.js";
