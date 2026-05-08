import { type Pool } from "@agent-desk/db";
import { networkInterfaces } from "node:os";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { workspaceRootPath } from "@agent-desk/storage";
import type { SandboxHandle } from "./docker.js";
import type { RunOptions, ExecResult, LogEvent } from "./driver.js";
import { createDriver } from "./driver.js";
import { mintToken, revokeToken } from "./sessions.js";
import { projectMounts, teardownMounts, SANDBOX_HOME } from "./mounts.js";
import { writeAgentFile, type AgentFileInput } from "./agentFile.js";

export interface ExecRunOptions {
  runId: string;
  prompt: string;
  home: string;
  workspaceId: string;
  workspaceSlug: string;
  chatId?: string;
  agent: AgentFileInput;
  /** Workspace-relative paths to forward to opencode as `--file` flags. */
  attachments?: string[];
  /**
   * Base URL the in-sandbox `desk` CLI uses to reach desk-server. Falls back
   * to the sandbox-reachable host gateway when omitted.
   */
  apiUrl?: string;
  /** Provider API keys forwarded into every exec so they're always current. */
  providerKeys?: Record<string, string>;
  onLog: (event: LogEvent) => void;
}

function firstNonInternalIpv4(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

function defaultSandboxApiUrl(): string {
  const configured = process.env.DESK_SANDBOX_API_URL;
  if (configured) return configured;

  const port = process.env.PORT ?? "35138";
  const hasLocalDockerBridge = Boolean(networkInterfaces().docker0?.some(
    (entry) => entry.family === "IPv4" && !entry.internal,
  ));
  const host = hasLocalDockerBridge ? "host.docker.internal" : firstNonInternalIpv4() ?? "host.docker.internal";
  return `http://${host}:${port}`;
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
  // single-bind workspace mount. The per-chat artifact paths and any
  // goal fragment are part of the rendered system prompt — no separate
  // chatContext prefix on the user prompt.
  await writeAgentFile(opts.home, opts.workspaceSlug, opts.agent);

  // Write the prompt to a file on the shared workspace mount instead of
  // passing it via DESK_PROMPT. Large chat transcripts can exceed ARG_MAX
  // (~1 MB on macOS) when packed into an execve environment block; a file
  // reference dodges that limit entirely.
  const wsRoot = workspaceRootPath(opts.home, opts.workspaceSlug);
  const promptHostPath = path.join(wsRoot, `.desk-prompt-${opts.runId}`);
  const promptSandboxPath = `${SANDBOX_HOME}/.desk-prompt-${opts.runId}`;
  await fsp.writeFile(promptHostPath, opts.prompt, "utf8");

  try {
    const driver = createDriver();
    const result = await driver.execRun(handle.workspaceId, {
      runId: opts.runId,
      prompt: opts.prompt,
      promptFile: promptSandboxPath,
      workspaceSlug: opts.workspaceSlug,
      agentFileId: opts.agent.agentId,
      attachments: opts.attachments,
      sandboxToken: token,
      apiUrl: opts.apiUrl ?? defaultSandboxApiUrl(),
      providerKeys: opts.providerKeys,
      onLog: opts.onLog,
    });
    return result;
  } finally {
    // Always clean up
    await revokeToken(pool, session.id);
    await teardownMounts(handle, opts.runId);
    await fsp.unlink(promptHostPath).catch(() => {});
  }
}

/**
 * Cancels a running run.
 */
export async function cancelRun(runId: string): Promise<void> {
  const driver = createDriver();
  await driver.cancelRun(runId);
}
