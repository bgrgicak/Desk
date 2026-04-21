import pg from "pg";
import type { SandboxHandle } from "./docker.js";
import type { RunOptions, ExecResult, LogEvent } from "./driver.js";
import { createDriver } from "./driver.js";
import { mintToken, revokeToken } from "./sessions.js";
import { projectMounts, teardownMounts } from "./mounts.js";

export interface ExecRunOptions {
  runId: string;
  prompt: string;
  systemPrompt?: string;
  chatContext?: string;
  home: string;
  workspaceId: string;
  chatId?: string;
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
  const { token, session } = await mintToken(pool, handle.agentId, { runId: opts.runId });

  // Project mounts and get the resolved MountSet so we can tell the agent
  // where to look for files inside the sandbox.
  const mounts = await projectMounts(handle, {
    home: opts.home,
    workspaceId: opts.workspaceId,
    chatId: opts.chatId,
    runId: opts.runId,
  });

  // Compose a filesystem hint that gets prepended to the caller's chatContext.
  // The agent reads files directly from the bind-mounts at /mnt/desk/*.
  const fsHint = [
    "You can access files on the host filesystem under /mnt/desk:",
    "- /mnt/desk/files      (read-only) workspace files",
    "- /mnt/desk/library    (read-only) library items",
    mounts.attachmentsInSandbox
      ? `- ${mounts.attachmentsInSandbox}    (read-only) attachments from this chat`
      : null,
    "- /mnt/desk/desktop    (read-write) scratch space for your own output",
  ]
    .filter(Boolean)
    .join("\n");
  const chatContext = opts.chatContext ? `${fsHint}\n\n${opts.chatContext}` : fsHint;

  try {
    const driver = createDriver();
    const result = await driver.execRun(handle.agentId, {
      runId: opts.runId,
      prompt: opts.prompt,
      systemPrompt: opts.systemPrompt,
      chatContext,
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
