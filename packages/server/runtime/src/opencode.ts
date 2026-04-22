import pg from "pg";
import type { SandboxHandle } from "./docker.js";
import type { RunOptions, ExecResult, LogEvent } from "./driver.js";
import { createDriver } from "./driver.js";
import { mintToken, revokeToken } from "./sessions.js";
import { projectMounts, teardownMounts } from "./mounts.js";
import { writeAgentFile, type AgentFileInput } from "./agentFile.js";

export interface ExecRunOptions {
  runId: string;
  prompt: string;
  chatContext?: string;
  home: string;
  workspaceId: string;
  chatId?: string;
  agent: AgentFileInput;
  onLog: (event: LogEvent) => void;
}

/**
 * Executes a run inside a sandbox.
 * Mints a session token, projects mounts, runs OpenCode, then cleans up.
 */
export async function execRun(
  pool: pg.Pool,
  handle: SandboxHandle,
  opts: ExecRunOptions,
): Promise<ExecResult> {
  // Session identifies the agent (not the workspace) so tool auth knows
  // which agent is asking.
  const { session } = await mintToken(pool, opts.agent.agentId, { runId: opts.runId });

  // Project mounts and get the resolved MountSet so we can tell the agent
  // where to look for files inside the sandbox.
  const mounts = await projectMounts(handle, {
    home: opts.home,
    workspaceId: opts.workspaceId,
    chatId: opts.chatId,
    runId: opts.runId,
  });

  // Write the OpenCode agent definition file into the sandbox.
  await writeAgentFile(handle.containerId, opts.agent);

  // Compose a per-run hint for chat attachments (only when present).
  // The static file-access docs live in the agent .md file; this just adds
  // the dynamic attachments path for the current chat.
  const attachmentHint = mounts.attachmentsInSandbox
    ? `Chat attachments are available at ${mounts.attachmentsInSandbox} (read-only).`
    : null;
  const chatContext = [attachmentHint, opts.chatContext].filter(Boolean).join("\n\n") || undefined;

  try {
    const driver = createDriver();
    const result = await driver.execRun(handle.workspaceId, {
      runId: opts.runId,
      prompt: opts.prompt,
      chatContext,
      agentFileId: opts.agent.agentId,
      onLog: opts.onLog,
    });
    return result;
  } finally {
    // Always clean up
    await revokeToken(pool, session.id);
    await teardownMounts(handle, opts.runId);
  }
}

/**
 * Cancels a running run.
 */
export async function cancelRun(runId: string): Promise<void> {
  const driver = createDriver();
  await driver.cancelRun(runId);
}
