import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SandboxHandle } from "./docker.js";
import { chatAttachmentsDir, summaryStorageDir, workspaceRootPath } from "@agent-desk/storage";

/**
 * Mount model (workspace-as-home):
 *
 *   host: ~/Desk/desk/              →   sandbox: /home/agent/   (rw)
 *
 * The workspace root *is* the agent's home directory inside the sandbox.
 * User-visible files live at the root; dot-prefixed entries (`.chats/`,
 * `.opencode/`, `.bashrc`, etc.) are hidden from the user's file-manager
 * view by the universal dotfile convention — every listing/search API
 * skips them unless `showHidden` is set.
 *
 * `projectMounts` is still called per run to:
 *   - resolve the current chat's attachments path inside the container so
 *     the agent knows where to look,
 *   - track active runs for a lightweight teardown counter.
 */

export const SANDBOX_HOME = "/home/agent";
export const SKILLS_SANDBOX_DIR = `${SANDBOX_HOME}/.config/opencode/skills`;
export const SKILLS_SANDBOX_MOUNT_DIR = "/opt/desk-skills";

/** Host-side global skills directory. Mounted read-only into each sandbox. */
export function skillsHostDir(home: string): string {
  return path.join(home, ".skills");
}

const activeMounts = new Map<string, Map<string, MountSet>>();

export interface MountSet {
  /** Host path of the workspace root (mounted at /home/agent inside the sandbox). */
  workspace: string;
  /** Host path of the current chat's attachments dir, if this run is chat-scoped. */
  attachments?: string;
  /** Path inside the container where the current chat's attachments live. */
  attachmentsInSandbox?: string;
}

/**
 * Records the current-run → current-chat mapping and ensures the workspace
 * root exists (so the bind-mount has something to show). Returns the
 * MountSet the driver can pass to OpenCode via the system prompt / chat
 * context.
 */
export async function projectMounts(
  handle: SandboxHandle,
  opts: { home: string; workspaceId: string; workspaceSlug: string; chatId?: string; runId: string },
): Promise<MountSet> {
  const wsRoot = workspaceRootPath(opts.home, opts.workspaceSlug);
  await fs.mkdir(wsRoot, { recursive: true });

  const mountSet: MountSet = {
    workspace: wsRoot,
  };

  if (opts.chatId) {
    const aHost = await chatAttachmentsDir(opts.home, opts.workspaceSlug, opts.chatId);
    mountSet.attachments = aHost;
    // The workspace is bind-mounted at /home/agent, so the chat's attachments
    // surface at this path inside the container.
    mountSet.attachmentsInSandbox = `${SANDBOX_HOME}/.chats/${opts.chatId}/attachments`;
    // Pre-create notes/ so the agent stops reporting "no summaries dir" before
    // the first materializeSummary() call. The system prompt advertises this
    // path in opencode.ts; matching it on disk keeps the two consistent.
    await fs.mkdir(summaryStorageDir(opts.home, opts.workspaceSlug, opts.chatId), { recursive: true });
  }

  if (!activeMounts.has(handle.workspaceId)) {
    activeMounts.set(handle.workspaceId, new Map());
  }
  activeMounts.get(handle.workspaceId)!.set(opts.runId, mountSet);

  return mountSet;
}

/** Drops the per-run tracking entry. The real bind-mount persists (set at container create). */
export async function teardownMounts(
  handle: SandboxHandle,
  runId: string,
): Promise<void> {
  const wsMounts = activeMounts.get(handle.workspaceId);
  if (wsMounts) {
    wsMounts.delete(runId);
    if (wsMounts.size === 0) {
      activeMounts.delete(handle.workspaceId);
    }
  }
}

/** Number of in-flight runs for the sandbox (used to gate teardown). */
export function activeRunCount(workspaceId: string): number {
  return activeMounts.get(workspaceId)?.size ?? 0;
}

/**
 * Declarative description of a single bind-mount into a sandbox. The
 * runtime compiles an array of these into Docker `Binds`.
 */
export interface MountPlanEntry {
  /** Absolute host path to bind. Must exist or be creatable by caller. */
  sourcePath: string;
  /** Absolute path inside the sandbox to bind onto. */
  targetPath: string;
  mode: "ro" | "rw";
  /**
   * Classifier used by tooling and debugging manifests. "external" covers
   * user-attached directories (e.g. ~/Projects/foo) that live outside the
   * Desk-managed tree.
   */
  category: "workspace" | "external";
}

export type MountPlan = MountPlanEntry[];

/**
 * Default mount plan — one rw bind of the workspace root onto the
 * container's $HOME, plus global Desk skills mounted read-only outside
 * $HOME and symlinked into OpenCode's skills path by the entrypoint. Custom
 * plans can be built by callers that need to expose additional directories
 * (e.g. ~/Projects) alongside.
 */
export function buildDefaultMountPlan(home: string, workspaceSlug: string): MountPlan {
  return [
    {
      sourcePath: workspaceRootPath(home, workspaceSlug),
      targetPath: SANDBOX_HOME,
      mode: "rw",
      category: "workspace",
    },
    {
      sourcePath: skillsHostDir(home),
      targetPath: SKILLS_SANDBOX_MOUNT_DIR,
      mode: "ro",
      category: "external",
    },
  ];
}

/**
 * Compiles a MountPlan into the Docker `Binds` string format
 * (`host:sandbox:mode`). Strips duplicate targets (last wins) so an
 * override plan can replace an entry from a base plan.
 */
export function bindsFromPlan(plan: MountPlan): string[] {
  const byTarget = new Map<string, string>();
  for (const entry of plan) {
    byTarget.set(entry.targetPath, `${entry.sourcePath}:${entry.targetPath}:${entry.mode}`);
  }
  return [...byTarget.values()];
}

/**
 * Legacy default bind list (kept for callers that haven't moved to a
 * MountPlan yet). Equivalent to `bindsFromPlan(buildDefaultMountPlan(...))`.
 */
export function containerBinds(home: string, workspaceSlug: string): string[] {
  return bindsFromPlan(buildDefaultMountPlan(home, workspaceSlug));
}
