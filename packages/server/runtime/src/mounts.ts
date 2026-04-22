import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SandboxHandle } from "./docker.js";
import { filesDir, libraryDir, chatsDir, chatAttachmentsDir } from "@desk/storage";

/**
 * Mount model for the sandbox (matches v1 spec §@desk/runtime):
 *
 *   /mnt/desk/files        ← ro bind of the workspace files dir
 *   /mnt/desk/library      ← ro bind of the library dir
 *   /mnt/desk/chats        ← ro bind of the chats tree (each chat has
 *                             attachments/ under its chatId)
 *   /mnt/desk/desktop      ← rw per-sandbox scratch dir
 *
 * The ro binds are attached once at container create time (binds are immutable
 * on running containers), and they stay live-synced with the host because
 * bind-mounts reflect the host filesystem in real time — a file uploaded via
 * the API appears inside the container immediately.
 *
 * `projectMounts` is still called per run to:
 *   - resolve the per-run MountSet (current chat's attachments path inside the
 *     container) so the agent knows where to look,
 *   - record a manifest on disk so the bridge between "which run" and "which
 *     chat" is observable,
 *   - bump a per-sandbox active-run counter that `teardownMounts` decrements.
 *
 * It does NOT create staging subdirs anymore — that was the previous design
 * that never populated them and left /mnt/desk/* empty inside the container.
 */

const activeMounts = new Map<string, Map<string, MountSet>>();

export interface MountSet {
  /** Host path of the files dir (also what the container sees at /mnt/desk/files). */
  files: string;
  /** Host path of the library dir. */
  library: string;
  /** Host path of the per-sandbox desktop scratch dir. */
  desktop: string;
  /** Host path of the current chat's attachments dir, if this run is chat-scoped. */
  attachments?: string;
  /** Path inside the container where the current chat's attachments live. */
  attachmentsInSandbox?: string;
}

/** Host path of the per-sandbox mount root. Keyed by workspace. */
export function sandboxMountRoot(home: string, workspaceId: string): string {
  return path.join(home, "sandbox-mounts", workspaceId);
}

/** Host path of a sandbox's desktop scratch dir. */
export function desktopDir(home: string, workspaceId: string): string {
  return path.join(sandboxMountRoot(home, workspaceId), "desktop");
}

/**
 * Records the current-run → current-chat mapping, ensures the real source
 * dirs exist (so the bind-mount shows non-empty content), and writes a
 * manifest for debugging. Returns the MountSet the driver can pass to
 * OpenCode via the system prompt / chat context.
 */
export async function projectMounts(
  handle: SandboxHandle,
  opts: { home: string; workspaceId: string; chatId?: string; runId: string },
): Promise<MountSet> {
  const fHost = filesDir(opts.home);
  const lHost = libraryDir(opts.home);
  const dHost = desktopDir(opts.home, handle.workspaceId);

  // Ensure every real source dir exists so the bind-mount has something to
  // show (an empty parent dir is fine; Docker is happy).
  await fs.mkdir(fHost, { recursive: true });
  await fs.mkdir(lHost, { recursive: true });
  await fs.mkdir(dHost, { recursive: true });

  const mountSet: MountSet = {
    files: fHost,
    library: lHost,
    desktop: dHost,
  };

  if (opts.chatId) {
    const aHost = await chatAttachmentsDir(opts.home, opts.chatId);
    mountSet.attachments = aHost;
    // The bind-mount exposes the whole chats tree, so a specific chat's
    // attachments appear at this path inside the container.
    mountSet.attachmentsInSandbox = `/mnt/desk/chats/${opts.chatId}/attachments`;
  }

  // Manifest for operator debugging: "which run saw which chat".
  const manifest = {
    runId: opts.runId,
    chatId: opts.chatId ?? null,
    host: mountSet,
    inSandbox: {
      files: "/mnt/desk/files",
      library: "/mnt/desk/library",
      desktop: "/mnt/desk/desktop",
      attachments: mountSet.attachmentsInSandbox ?? null,
    },
  };
  await fs.mkdir(sandboxMountRoot(opts.home, handle.workspaceId), { recursive: true });
  await fs.writeFile(
    path.join(sandboxMountRoot(opts.home, handle.workspaceId), `manifest-${opts.runId}.json`),
    JSON.stringify(manifest, null, 2),
  );

  if (!activeMounts.has(handle.workspaceId)) {
    activeMounts.set(handle.workspaceId, new Map());
  }
  activeMounts.get(handle.workspaceId)!.set(opts.runId, mountSet);

  return mountSet;
}

/** Drops the per-run tracking entry. The real bind-mounts persist (set at container create). */
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
 * The bind specs passed to Docker at container create time.
 *   files/library/chats are read-only so the agent cannot tamper with source.
 *   desktop is read-write so the agent has a scratch area.
 */
export function containerBinds(home: string, workspaceId: string): string[] {
  return [
    `${filesDir(home)}:/mnt/desk/files:ro`,
    `${libraryDir(home)}:/mnt/desk/library:ro`,
    `${chatsDir(home)}:/mnt/desk/chats:ro`,
    `${desktopDir(home, workspaceId)}:/mnt/desk/desktop:rw`,
  ];
}
