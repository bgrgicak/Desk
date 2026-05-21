import * as fs from "node:fs/promises";
import * as path from "node:path";
import { queries, type Pool } from "@agent-desk/db";
import {
  ConflictError,
  LOCAL_FILESYSTEM_MOUNT_MARKER,
  LOCAL_FILESYSTEM_PROVIDER_ID,
  type LocalFilesystemConnectionMetadata,
  type LocalFilesystemDirectoryConfig,
} from "@agent-desk/shared";
import type { SandboxHandle } from "./docker.js";
import { chatAttachmentsDir, summaryStorageDir, workspaceRootPath } from "@agent-desk/storage";

/**
 * Mount model (workspace-as-home):
 *
 *   host: ~/Desk/desk/              →   sandbox: /home/agent/   (rw)
 *
 * The workspace root *is* the agent's home directory inside the sandbox.
 * User-visible files live at the root; dot-prefixed entries (`.chats/`,
 * `.agents/`, `.bashrc`, etc.) are hidden from the user's file-manager
 * view by the universal dotfile convention — every listing/search API
 * skips them unless `showHidden` is set.
 *
 * `projectMounts` is still called per run to:
 *   - resolve the current chat's attachments path inside the container so
 *     the agent knows where to look,
 *   - track active runs for a lightweight teardown counter.
 */

export const SANDBOX_HOME = "/home/agent";
// Pi auto-discovers skills under `~/.agents/skills` (Agent Skills standard).
// The host's bundled skills are mounted read-only at SKILLS_SANDBOX_MOUNT_DIR
// and symlinked here by the sandbox entrypoint.
export const SKILLS_SANDBOX_DIR = `${SANDBOX_HOME}/.agents/skills`;
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
  /** When false, createOrReuse must not create a missing source path. */
  ensureSource?: boolean;
  /** Stable identity for nested mount-point placeholder directories. */
  mountPointId?: string;
}

export type MountPlan = MountPlanEntry[];

/**
 * Default mount plan — one rw bind of the workspace root onto the
 * container's $HOME, plus global Desk skills mounted read-only outside
 * $HOME and symlinked into OpenCode's skills path by the entrypoint. Custom
 * plans can be built by callers that need to expose additional directories
 * (e.g. ~/Projects) alongside.
 *
 * Optional `siblingWorkspaceSlugs` lists OTHER workspace slugs the user
 * owns; each is added as a read-only bind under
 * `~/workspaces/{slug}/`. The hub mounts every owned workspace this way
 * so the hub agent can read any workspace's files without being able to
 * write to them. The list never includes `workspaceSlug` itself
 * (that's the rw $HOME mount).
 */
export const HUB_SIBLING_MOUNT_DIR = `${SANDBOX_HOME}/workspaces`;

export function buildDefaultMountPlan(
  home: string,
  workspaceSlug: string,
  siblingWorkspaceSlugs: string[] = [],
): MountPlan {
  const plan: MountPlan = [
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
  for (const slug of siblingWorkspaceSlugs) {
    if (slug === workspaceSlug) continue;
    plan.push({
      sourcePath: workspaceRootPath(home, slug),
      targetPath: `${HUB_SIBLING_MOUNT_DIR}/${slug}`,
      mode: "ro",
      category: "external",
    });
  }
  return plan;
}

export interface LocalFilesystemAgentDirectory {
  path: string;
  access: LocalFilesystemDirectoryConfig["access"];
  description?: string;
}

export interface LocalFilesystemMountResolution {
  mountPlan: MountPlan;
  agentDirectories: LocalFilesystemAgentDirectory[];
}

function localFilesystemDirectories(metadata: Record<string, unknown>): LocalFilesystemDirectoryConfig[] {
  const parsed = metadata as Partial<LocalFilesystemConnectionMetadata>;
  return Array.isArray(parsed.localFilesystem?.directories)
    ? parsed.localFilesystem.directories.filter((dir): dir is LocalFilesystemDirectoryConfig => (
      Boolean(dir)
      && typeof dir.hostPath === "string"
      && typeof dir.homeName === "string"
      && (dir.access === "read_only" || dir.access === "read_write")
    ))
    : [];
}

async function readMountMarker(targetPath: string): Promise<{ mountId?: string } | null> {
  try {
    const raw = await fs.readFile(path.join(targetPath, LOCAL_FILESYSTEM_MOUNT_MARKER), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as { mountId?: string } : null;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return null;
    return null;
  }
}

async function targetIsAvailableMountPoint(targetPath: string, _mountId: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(targetPath);
    if (!stat.isDirectory()) return false;
    const marker = await readMountMarker(targetPath);
    // Any Desk local-filesystem marker means this directory is only a host-side
    // placeholder for a nested bind mount. The directory id can change when the
    // connection is edited, so do not treat a stale marker id as user content.
    // Duplicate selected mount names are rejected before this check.
    if (marker?.mountId) return true;
    return false;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return true;
    throw err;
  }
}

export async function buildWorkspaceMountPlan(
  pool: Pool,
  opts: {
    home: string;
    workspaceId: string;
    workspaceSlug: string;
    userId?: string | null;
    siblingWorkspaceSlugs?: string[];
  },
): Promise<LocalFilesystemMountResolution> {
  const mountPlan = buildDefaultMountPlan(opts.home, opts.workspaceSlug, opts.siblingWorkspaceSlugs ?? []);
  const agentDirectories: LocalFilesystemAgentDirectory[] = [];
  if (!opts.userId) return { mountPlan, agentDirectories };

  const workspaceRoot = workspaceRootPath(opts.home, opts.workspaceSlug);
  const grants = await queries.connectors.listWorkspaceGrants(pool, opts.workspaceId);
  const localGrantIds = grants
    .filter((grant) => grant.providerId === LOCAL_FILESYSTEM_PROVIDER_ID)
    .map((grant) => grant.connectionId);
  const all = await queries.connectors.listConnections(pool, opts.userId, LOCAL_FILESYSTEM_PROVIDER_ID);
  const active = all.filter((connection) => connection.status === "active");
  const selected = localGrantIds.length > 0
    ? active.filter((connection) => localGrantIds.includes(connection.id))
    : active;

  const seenHomeNames = new Set<string>();
  for (const connection of selected) {
    for (const directory of localFilesystemDirectories(connection.metadata)) {
      const homeName = path.basename(directory.homeName);
      if (seenHomeNames.has(homeName.toLowerCase())) {
        throw new ConflictError(`Multiple local filesystem directories want to mount at ~/${homeName}`);
      }
      seenHomeNames.add(homeName.toLowerCase());

      const targetPath = path.join(workspaceRoot, homeName);
      const mountId = `${connection.id}:${directory.id}`;
      if (!(await targetIsAvailableMountPoint(targetPath, mountId))) {
        throw new ConflictError(`~/${homeName} already exists. Rename or remove it, or choose a different mount name.`);
      }
      const sourceStat = await fs.stat(directory.hostPath).catch(() => null);
      if (!sourceStat?.isDirectory()) {
        throw new ConflictError(`Local filesystem source is not available: ${directory.hostPath}`);
      }

      mountPlan.push({
        sourcePath: directory.hostPath,
        targetPath: `${SANDBOX_HOME}/${homeName}`,
        mode: directory.access === "read_only" ? "ro" : "rw",
        category: "external",
        ensureSource: false,
        mountPointId: mountId,
      });
      agentDirectories.push({
        path: `~/${homeName}`,
        access: directory.access,
        ...(directory.description ? { description: directory.description } : {}),
      });
    }
  }

  return { mountPlan, agentDirectories };
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
