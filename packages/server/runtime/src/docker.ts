/**
 * Docker sandbox lifecycle management.
 * In v1: one sandbox per agent (one agent total).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { PROVIDER_KEY_VARS } from "@desk/shared";
import {
  bindsFromPlan,
  buildDefaultMountPlan,
  type MountPlan,
} from "./mounts.js";

/**
 * Resolves the Docker socket path from the active docker context.
 * Falls back to the default `/var/run/docker.sock`.
 */
function resolveDockerSocket(): string {
  if (process.env.DOCKER_HOST) {
    // e.g. "unix:///run/user/1000/docker.sock"
    const match = process.env.DOCKER_HOST.match(/^unix:\/\/(.+)/);
    if (match) return match[1];
  }
  try {
    const host = execFileSync(
      "docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] },
    ).trim();
    const match = host.match(/^unix:\/\/(.+)/);
    if (match) return match[1];
  } catch { /* fall through */ }
  return "/var/run/docker.sock";
}

/** Cached socket path. */
let _socketPath: string | undefined;
export function dockerSocketPath(): string {
  if (!_socketPath) _socketPath = resolveDockerSocket();
  return _socketPath;
}

export interface SandboxHandle {
  containerId: string;
  /** Workspace this sandbox belongs to. One sandbox per workspace; any of the workspace's agents can exec through it. */
  workspaceId: string;
}

/**
 * Ensures the sandbox Docker image exists.
 * Called by the installer, not at runtime.
 */
export async function ensureImage(): Promise<void> {
  if (process.env.DESK_SANDBOX_DRIVER === "fake") return;

  const Docker = (await import("dockerode")).default;
  const docker = new Docker({ socketPath: dockerSocketPath() });

  try {
    await docker.getImage("desk/sandbox:v1").inspect();
  } catch {
    console.warn("desk/sandbox:v1 image not found. Run install.sh to build it.");
  }
}

/**
 * Creates or reuses a sandbox container for a workspace. One container per
 * workspace, any agent enrolled in the workspace execs through it.
 *
 * `providerKeys` is an optional map of AI-provider credentials to inject as
 * env vars. When omitted the function falls back to reading the host env —
 * that legacy path is what tests without DB access use.
 */
export async function createOrReuse(
  workspaceId: string,
  home?: string,
  providerKeys?: Record<string, string>,
  mountPlan?: MountPlan,
): Promise<SandboxHandle> {
  if (process.env.DESK_SANDBOX_DRIVER === "fake") {
    return { containerId: `fake-${workspaceId}`, workspaceId };
  }

  const Docker = (await import("dockerode")).default;
  const docker = new Docker({ socketPath: dockerSocketPath() });
  const containerName = `desk-sandbox-${workspaceId}`;

  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
    return { containerId: info.Id, workspaceId };
  } catch {
    const deskHome = home ?? process.env.DESK_HOME ?? "/opt/desk";
    const plan = mountPlan ?? buildDefaultMountPlan(deskHome, workspaceId);

    // Pre-create every source dir in the plan so Docker doesn't auto-create
    // them as root and break subsequent non-root writes.
    for (const entry of plan) {
      await fs.mkdir(entry.sourcePath, { recursive: true });
    }

    const toolSocket = process.env.DESK_TOOL_SOCKET;
    const binds = [
      ...bindsFromPlan(plan),
      // Only mount the tool socket when it actually exists on the host. Binding
      // a non-existent path makes Docker create an empty directory there,
      // which then confuses the sandbox CLI. With the socket absent, the
      // in-sandbox CLI surfaces a clear "tool socket missing" error instead.
      ...(toolSocket ? [`${toolSocket}:/run/desk/tools.sock`] : []),
    ];

    const container = await docker.createContainer({
      name: containerName,
      Image: "desk/sandbox:v1",
      Env: providerKeyEnv(providerKeys),
      HostConfig: {
        CapDrop: ["ALL"],
        NetworkMode: "bridge",
        PidsLimit: 256,
        Memory: 512 * 1024 * 1024,
        Tmpfs: { "/tmp": "" },
        Binds: binds,
      },
    });
    await container.start();
    const info = await container.inspect();
    return { containerId: info.Id, workspaceId };
  }
}

/**
 * Formats AI-provider credentials as Docker Env entries.
 *
 * With `keys` provided, uses that map (intersected with PROVIDER_KEY_VARS to
 * avoid leaking unrelated env into the container). Without, falls back to
 * the host process env — a legacy path for tests and dev flows that haven't
 * moved to DB-backed keys yet.
 *
 * Only keys with non-empty values are emitted, so opencode's auto-detection
 * doesn't light up empty providers.
 */
function providerKeyEnv(keys?: Record<string, string>): string[] {
  const out: string[] = [];
  const source: Record<string, string | undefined> = keys ?? process.env;
  for (const name of PROVIDER_KEY_VARS) {
    const v = source[name];
    if (v && v.length > 0) out.push(`${name}=${v}`);
  }
  return out;
}

/**
 * Stops a sandbox container.
 */
export async function stopSandbox(handle: SandboxHandle): Promise<void> {
  if (process.env.DESK_SANDBOX_DRIVER === "fake") return;

  const Docker = (await import("dockerode")).default;
  const docker = new Docker({ socketPath: dockerSocketPath() });

  try {
    const container = docker.getContainer(handle.containerId);
    await container.stop({ t: 10 });
  } catch {
    // Container may already be stopped
  }
}
