import { type Pool } from "@agent-desk/db";
import { networkInterfaces } from "node:os";
import { type WorkspaceKind } from "@agent-desk/shared";
import type { SandboxHandle } from "./docker.js";
import type { ExecResult, LogEvent } from "./driver.js";
import { createDriver } from "./driver.js";
import { mintToken, revokeToken } from "./sessions.js";
import { projectMounts, teardownMounts, type MountPlan } from "./mounts.js";
import { writeAgentFile, writeWorkspaceMcpConfig, chatNeedsBrowser, type AgentFileInput } from "./agentFile.js";
import { restartOpencodeServer, invalidateOpencodeServerCache, ensureContainerXvfb } from "./opencodeServer.js";
import { detectEngine } from "./engine.js";
import { sandboxUser } from "./docker.js";
import { SANDBOX_HOME } from "./mounts.js";

export interface ExecRunOptions {
  runId: string;
  prompt: string;
  home: string;
  workspaceId: string;
  workspaceSlug: string;
  /**
   * Kind of the requesting workspace. Threaded from the caller (the
   * scheduler) so the runtime never re-derives kind from the DB. Drives
   * the prompt fragment selection and the sandbox image selection. Defaults
   * to `project` so callers that don't yet pass it stay unchanged.
   */
  workspaceKind?: WorkspaceKind;
  chatId?: string;
  agent: AgentFileInput;
  /**
   * Workspace-relative paths the user attached to this message. Folded
   * into the opencode message as additional text parts so the model sees
   * their content; see `driver.buildMessageParts`.
   */
  attachments?: string[];
  /**
   * Base URL the in-sandbox `desk` CLI uses to reach desk-server. Falls back
   * to the sandbox-reachable host gateway when omitted.
   */
  apiUrl?: string;
  /** Provider API keys forwarded into the opencode-serve daemon's env. */
  providerKeys?: Record<string, string>;
  /**
   * Non-key env entries — currently used for the Codex/ChatGPT bridge
   * (`OPENCODE_AUTH_CONTENT`).
   */
  extraEnv?: Record<string, string>;
  mountPlan?: MountPlan;
  /**
   * Existing opencode-serve session for this chat. Null/undefined on the
   * chat's first turn under the new runtime — the runtime creates a
   * session and surfaces its id back via `ExecResult.opencodeSessionId`
   * for the caller (the scheduler) to persist on the chat row.
   */
  opencodeSessionId?: string | null;
  onLog: (event: LogEvent) => void;
}

/**
 * Per-workspace serial queue for MCP-config writes + daemon restarts.
 *
 * Two `execRun` calls for the same workspace with different goals
 * both have to (a) decide whether the workspace's `.opencode/opencode.json`
 * needs changing, (b) write it if so, (c) trigger an opencode-serve
 * restart. Without serialization, those steps interleave: both calls
 * see the old config, both write, both restart. The second restart
 * either no-ops (if the daemon already came back up) or fails with
 * port-in-use.
 *
 * One promise chain per workspaceId; entries are pruned in `finally`
 * when they're the tail. Cross-workspace work is independent.
 */
const mcpLocks = new Map<string, Promise<unknown>>();
async function withMcpLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = mcpLocks.get(workspaceId);
  const next = (prev ?? Promise.resolve()).then(fn, fn);
  // The caller awaits `next` (rejection handled there). The tail promise
  // stored in the map needs its own `.catch` or a failed `fn` becomes an
  // unhandledRejection that crashes the process.
  const tail = next.finally(() => {
    if (mcpLocks.get(workspaceId) === tail) mcpLocks.delete(workspaceId);
  });
  tail.catch(() => {});
  mcpLocks.set(workspaceId, tail);
  return next;
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

  // Pre-create the workspace + attachments mount points on the host.
  // projectMounts() does the fs.mkdir as a side effect; the returned
  // MountSet is intentionally unused here — bind-mount wiring lives
  // inside the engine and reads its own copy.
  await projectMounts(handle, {
    home: opts.home,
    workspaceId: opts.workspaceId,
    workspaceSlug: opts.workspaceSlug,
    chatId: opts.chatId,
    runId: opts.runId,
  });

  // Write the OpenCode agent definition file to the host workspace. It
  // lands inside the sandbox at ~/.opencode/agents/{agentId}.md via the
  // single-bind workspace mount. The per-chat artifact paths and any
  // goal fragment are part of the rendered system prompt.
  await writeAgentFile(opts.home, opts.workspaceSlug, opts.agent);

  // MCP config write + daemon-restart side-effects are serialized per
  // workspace via `withMcpLock`. Two chats in the same workspace with
  // different goals (one needs playwright, the other doesn't) used to
  // race — each call read+wrote the workspace's `.opencode/opencode.json`
  // and both decided to restart the daemon, racing on port-9105.
  // Serializing inside the workspace keeps "current MCP state" coherent
  // and the restart decision atomic. Cross-workspace concurrency is
  // unaffected — each workspace has its own lock.
  await withMcpLock(opts.workspaceId, async () => {
    // Lazy MCP: refresh the workspace-level opencode config so
    // playwright is only present when the chat goal actually needs a
    // browser. If the config changed compared to the last write,
    // restart the in-sandbox opencode-serve daemon so it picks up the
    // new MCP set — the daemon loads its config at boot.
    const mcpResult = await writeWorkspaceMcpConfig(opts.home, opts.workspaceSlug, {
      enablePlaywright: chatNeedsBrowser(opts.agent.goal),
    });

    // Browser-goal chats need Xvfb; chat-goal chats don't, and Xvfb
    // is expensive (~68 MB resident). Start it lazily whenever
    // playwright is enabled — idempotent, so a no-op when already up.
    // Order matters: Xvfb must exist *before* the daemon spawns its
    // playwright MCP child.
    if (process.env.DESK_SANDBOX_DRIVER !== "fake" && chatNeedsBrowser(opts.agent.goal)) {
      try {
        const engine = await detectEngine();
        await ensureContainerXvfb(engine, handle.containerId).catch(() => {});
      } catch {
        // best-effort; playwright will fail loudly if it ends up
        // needing a display that never came up.
      }
    }

    // Skip the daemon-restart side-effect under the fake driver —
    // there's no real container behind `handle.containerId`, so
    // engine.inspect / engine.exec would fail and emit an unhandled
    // rejection during test teardown.
    if (process.env.DESK_SANDBOX_DRIVER !== "fake" && mcpResult?.changed) {
      try {
        const engine = await detectEngine();
        await restartOpencodeServer(engine, {
          containerId: handle.containerId,
          cwd: SANDBOX_HOME,
          user: await sandboxUser(engine),
          env: {},
        }).catch(() => invalidateOpencodeServerCache(handle.containerId));
      } catch {
        invalidateOpencodeServerCache(handle.containerId);
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
      apiUrl: opts.apiUrl ?? defaultSandboxApiUrl(),
      // Forward the agent's currently-saved model so the per-message
      // `providerID/modelID` sent to opencode-serve reflects the user's
      // live UI selection. Without this, the driver falls back to a
      // default and the daemon ends up using whatever model it bound
      // to the session at creation time — so changing the model in
      // the UI never propagates to subsequent turns.
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

/**
 * Cancels a running run.
 */
export async function cancelRun(runId: string): Promise<void> {
  const driver = createDriver();
  await driver.cancelRun(runId);
}
