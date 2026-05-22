/**
 * Top-level `execRun` entry point — composes mounts + agent file +
 * driver invocation for one turn. The runtime underneath is pi.
 *
 * MCP is deferred — when we bring it back via a pi extension, the
 * per-workspace `withMcpLock` queue comes with it (scoped to whatever
 * shared config the extension reads), and the lazy Xvfb start path
 * already in this file extends to cover any future browser-bearing
 * extensions.
 */

import { type Pool } from "@agent-desk/db";
import { networkInterfaces } from "node:os";
import { type WorkspaceKind } from "@agent-desk/shared";
import type { SandboxHandle } from "./docker.js";
import type { ExecResult, LogEvent } from "./driver.js";
import { createDriver } from "./driver.js";
import { mintToken, revokeToken } from "./sessions.js";
import { projectMounts, teardownMounts, type MountPlan } from "./mounts.js";
import { writeAgentFile, writeWorkspaceMcpConfig, chatNeedsBrowser, type AgentFileInput } from "./agentFile.js";
import { detectEngine, type Engine } from "./engine.js";
import { withModule } from "@agent-desk/shared/logger";
const log = withModule("runtime/execRun");

/**
 * Per-workspace serial queue for MCP-config writes + lazy Xvfb start.
 *
 * Two `execRun` calls for the same workspace with different goals both
 * have to (a) decide whether the workspace's `.agents/mcp.json` needs
 * changing, (b) write it if so, (c) maybe start Xvfb. Without
 * serialization, those steps interleave: both calls see the old config
 * and both write — usually harmless but the Xvfb path is racey under
 * Docker exec.
 *
 * One promise chain per workspaceId; entries are pruned in `finally`
 * when they're the tail. Cross-workspace work is independent.
 */
const mcpLocks = new Map<string, Promise<unknown>>();
async function withMcpLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = mcpLocks.get(workspaceId);
  const next = (prev ?? Promise.resolve()).then(fn, fn);
  const tail = next.finally(() => {
    if (mcpLocks.get(workspaceId) === tail) mcpLocks.delete(workspaceId);
  });
  tail.catch(() => {});
  mcpLocks.set(workspaceId, tail);
  return next;
}

/**
 * Idempotently start an Xvfb display inside the container for the
 * playwright-mcp server the desk-mcp-bridge extension will spawn.
 * Skipped entirely for non-browser-goal chats so the ~68 MiB
 * framebuffer doesn't sit warm for sandboxes that never open a browser.
 *
 * Safe to call repeatedly: the shell script's `pgrep` check makes the
 * second call a no-op.
 */
export async function ensureContainerXvfb(
  engine: Engine,
  containerId: string,
): Promise<void> {
  const cmd = [
    "sh", "-c",
    [
      "set -e",
      "if pgrep -x Xvfb >/dev/null 2>&1; then exit 0; fi",
      "DISPLAY=\"${DISPLAY:-:99}\"",
      "Xvfb \"$DISPLAY\" -screen 0 \"${XVFB_SCREEN:-1920x1080x24}\" -nolisten tcp >/tmp/desk-xvfb.log 2>&1 &",
      "for _ in 1 2 3 4 5 6 7 8 9 10; do",
      "  [ -S \"/tmp/.X11-unix/X${DISPLAY#:}\" ] && exit 0",
      "  sleep 0.1",
      "done",
    ].join("\n"),
  ];
  await engine.execDetached({ containerId, cmd });
}

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
  /** Ordered runtime model ids to try after `agent.model` fails. */
  modelFallbacks?: string[];
  mountPlan?: MountPlan;
  /**
   * Existing pi session id for this chat. Null/undefined on the chat's
   * first turn — the driver picks one (chatId or a fresh UUID) and
   * surfaces it via `ExecResult.piSessionId` for the caller (the
   * scheduler) to persist on the chat row.
   */
  piSessionId?: string | null;
  onLog: (event: LogEvent) => void;
}

function firstNonInternalIpv4(): string | null {
  for (const entries of Object.values(safeNetworkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

function safeNetworkInterfaces(): ReturnType<typeof networkInterfaces> {
  try {
    return networkInterfaces();
  } catch {
    return {};
  }
}

function defaultSandboxApiUrl(): string {
  const configured = process.env.DESK_SANDBOX_API_URL;
  if (configured) return configured;

  const port = process.env.PORT ?? "35138";
  const interfaces = safeNetworkInterfaces();
  const hasLocalDockerBridge = Boolean(interfaces.docker0?.some(
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

  // MCP config write + lazy-Xvfb start are serialized per workspace via
  // `withMcpLock`. Two chats in the same workspace with different goals
  // (one needs playwright, the other doesn't) used to race — each call
  // read+wrote the workspace's `.agents/mcp.json` and both decided
  // whether to start Xvfb. Serializing inside the workspace keeps
  // "current MCP state" coherent. Cross-workspace concurrency is
  // unaffected — each workspace has its own lock.
  await withMcpLock(opts.workspaceId, async () => {
    await writeWorkspaceMcpConfig(opts.home, opts.workspaceSlug, {
      enablePlaywright: chatNeedsBrowser(opts.agent.goal),
    });

    // Lazy Xvfb. Browser-goal chats need it; chat-goal chats don't, and
    // Xvfb is expensive (~68 MiB resident). Start it lazily whenever
    // playwright is enabled — idempotent, so a no-op when already up.
    // Order matters: Xvfb must exist *before* pi spawns its
    // desk-mcp-bridge → playwright-mcp → firefox child.
    if (process.env.DESK_SANDBOX_DRIVER !== "fake" && chatNeedsBrowser(opts.agent.goal)) {
      try {
        const engine = await detectEngine();
        await ensureContainerXvfb(engine, handle.containerId).catch(() => {
          // best-effort; playwright-mcp will surface a clear error if
          // it ends up needing a display that never came up.
        });
      } catch (err) {
        log.warn({ workspaceId: opts.workspaceId, err: (err as Error)?.message }, "lazy Xvfb start failed");
      }
    }
  });

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
      modelFallbacks: opts.modelFallbacks,
      providerKeys: opts.providerKeys,
      extraEnv: opts.extraEnv,
      mountPlan: opts.mountPlan,
      piSessionId: opts.piSessionId ?? null,
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
