import { type Pool } from "@desk/db";
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
  workspaceSlug: string;
  chatId?: string;
  agent: AgentFileInput;
  /** Workspace-relative paths to forward to opencode as `--file` flags. */
  attachments?: string[];
  /**
   * Base URL the in-sandbox `desk` CLI uses to reach desk-server. Falls back
   * to `http://host.docker.internal:8080` when omitted.
   */
  apiUrl?: string;
  /** Provider API keys forwarded into every exec so they're always current. */
  providerKeys?: Record<string, string>;
  onLog: (event: LogEvent) => void;
}

/**
 * Executes a run inside a sandbox.
 * Mints a session token, projects mounts, runs OpenCode, then cleans up.
 */
export async function execRun(
  pool: Pool,
  handle: SandboxHandle,
  opts: ExecRunOptions,
): Promise<ExecResult> {
  // The session token authenticates the in-sandbox `desk` CLI back to the
  // host REST API for the duration of this run; we revoke it in `finally`.
  // Token resolves to (session, agent) server-side via
  // `authenticateSandboxToken`; the agent's userId then gates ownership.
  const { token, session } = await mintToken(pool, opts.agent.agentId, {
    runId: opts.runId,
    workspaceId: opts.workspaceId,
  });

  // Track the run + write a manifest for operator debugging.
  const mounts = await projectMounts(handle, {
    home: opts.home,
    workspaceId: opts.workspaceId,
    workspaceSlug: opts.workspaceSlug,
    chatId: opts.chatId,
    runId: opts.runId,
  });

  // Write the OpenCode agent definition file to the host workspace. It
  // lands inside the sandbox at ~/.opencode/agents/{agentId}.md via the
  // single-bind workspace mount.
  await writeAgentFile(opts.home, opts.workspaceSlug, opts.agent);

  // Tell the agent which chat it's in. The per-chat workbench path is
  // encoded in the system prompt as a template; here we anchor it and
  // name the attachments/ + notes/ subdirs so the agent reads real
  // paths instead of guessing.
  const workbenchHint = opts.chatId
    ? [
        `Current chat workbench: ~/.chats/${opts.chatId}/`,
        `Chat attachments: ~/.chats/${opts.chatId}/attachments/`,
        `Chat notes:       ~/.chats/${opts.chatId}/notes/`,
      ].join("\n")
    : null;
  const chatContext = [workbenchHint, opts.chatContext].filter(Boolean).join("\n\n") || undefined;

  try {
    const driver = createDriver();
    const result = await driver.execRun(handle.workspaceId, {
      runId: opts.runId,
      prompt: opts.prompt,
      chatContext,
      workspaceSlug: opts.workspaceSlug,
      agentFileId: opts.agent.agentId,
      attachments: opts.attachments,
      sandboxToken: token,
      apiUrl: opts.apiUrl ?? "http://host.docker.internal:8080",
      providerKeys: opts.providerKeys,
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
