/**
 * Top-level `execRun` entry point — composes mounts + agent file +
 * driver invocation for one turn. Kept in this filename for import
 * stability; the runtime underneath is now pi, not opencode.
 *
 * Compared to the old opencode-daemon version this module loses:
 *   - the `withMcpLock` per-workspace serial queue (pi has no MCP yet,
 *     no shared config file to race on),
 *   - the lazy MCP / Xvfb start path,
 *   - the daemon-restart-on-config-change side-effect.
 *
 * MCP is deferred — when we bring it back via a pi extension, the lock
 * comes with it (same shape, scoped to whatever shared config the
 * extension reads).
 */

import { type Pool } from "@agent-desk/db";
import { networkInterfaces } from "node:os";
import { type WorkspaceKind } from "@agent-desk/shared";
import type { SandboxHandle } from "./docker.js";
import type { ExecResult, LogEvent } from "./driver.js";
import { createDriver } from "./driver.js";
import { mintToken, revokeToken } from "./sessions.js";
import { projectMounts, teardownMounts, type MountPlan } from "./mounts.js";
import { writeAgentFile, type AgentFileInput } from "./agentFile.js";

export interface ExecRunOptions {
  runId: string;
  prompt: string;
  home: string;
  workspaceId: string;
  workspaceSlug: string;
  /** Drives prompt-fragment selection and sandbox image selection. */
  workspaceKind?: WorkspaceKind;
  chatId?: string;
  agent: AgentFileInput;
  attachments?: string[];
  apiUrl?: string;
  /** Provider API keys forwarded into pi's env. */
  providerKeys?: Record<string, string>;
  /** Non-key env entries (e.g. the Codex/ChatGPT bridge content). */
  extraEnv?: Record<string, string>;
  mountPlan?: MountPlan;
  /**
   * Existing pi session id for this chat. Null/undefined on the chat's
   * first turn — the driver picks one (chatId or a fresh UUID) and
   * surfaces it via `ExecResult.opencodeSessionId` for the caller (the
   * scheduler) to persist on the chat row.
   */
  opencodeSessionId?: string | null;
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
 * Mints a session token, projects mounts, writes the agent file, runs
 * pi, then cleans up.
 */
export async function execRun(
  pool: Pool,
  handle: SandboxHandle,
  opts: ExecRunOptions,
): Promise<ExecResult> {
  const { token, session } = await mintToken(pool, opts.agent.agentId, {
    runId: opts.runId,
    workspaceId: opts.workspaceId,
  });

  await projectMounts(handle, {
    home: opts.home,
    workspaceId: opts.workspaceId,
    workspaceSlug: opts.workspaceSlug,
    chatId: opts.chatId,
    runId: opts.runId,
  });

  // Renders the AGENTS.md system prompt for pi at the workspace root.
  // Pi auto-loads AGENTS.md from cwd up through parents, so a single
  // file at the workspace root is visible to every turn.
  await writeAgentFile(opts.home, opts.workspaceSlug, opts.agent);

  try {
    const driver = createDriver();
    const result = await driver.execRun(handle.workspaceId, {
      runId: opts.runId,
      prompt: opts.prompt,
      home: opts.home,
      workspaceSlug: opts.workspaceSlug,
      chatId: opts.chatId,
      agentFileId: opts.agent.agentId,
      attachments: opts.attachments,
      sandboxToken: token,
      // When DESK_SANDBOX_NETWORK=none the host-gateway entry is
      // dropped, so `host.docker.internal` won't resolve. Suppressing
      // DESK_API_URL surfaces the existing "DESK_API_URL is not set"
      // error from the in-sandbox CLI immediately, not a TCP timeout.
      apiUrl: process.env.DESK_SANDBOX_NETWORK === "none"
        ? undefined
        : (opts.apiUrl ?? defaultSandboxApiUrl()),
      model: opts.agent.model,
      providerKeys: opts.providerKeys,
      extraEnv: opts.extraEnv,
      mountPlan: opts.mountPlan,
      opencodeSessionId: opts.opencodeSessionId ?? null,
      onLog: opts.onLog,
    });
    return result;
  } finally {
    await revokeToken(pool, session.id);
    await teardownMounts(handle, opts.runId);
  }
}

/** Cancels a running run. */
export async function cancelRun(runId: string): Promise<void> {
  const driver = createDriver();
  await driver.cancelRun(runId);
}
