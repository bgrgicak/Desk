/**
 * Docker sandbox lifecycle management.
 * In v1: one sandbox per agent (one agent total).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { filesDir, libraryDir, chatsDir } from "@desk/storage";
import { containerBinds, desktopDir } from "./mounts.js";

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
  agentId: string;
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
 * Creates or reuses a sandbox container for an agent.
 * The container gets /mnt/desk bind-mounted from the per-sandbox staging dir.
 */
export async function createOrReuse(agentId: string, home?: string): Promise<SandboxHandle> {
  if (process.env.DESK_SANDBOX_DRIVER === "fake") {
    return { containerId: `fake-${agentId}`, agentId };
  }

  const Docker = (await import("dockerode")).default;
  const docker = new Docker({ socketPath: dockerSocketPath() });
  const containerName = `desk-sandbox-${agentId}`;

  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
    return { containerId: info.Id, agentId };
  } catch {
    const deskHome = home ?? process.env.DESK_HOME ?? "/opt/desk";

    // Pre-create the real source dirs (files/library/chats) and the
    // per-sandbox desktop scratch as the current user, so Docker doesn't
    // auto-create them as root and break subsequent non-root writes.
    await fs.mkdir(filesDir(deskHome), { recursive: true });
    await fs.mkdir(libraryDir(deskHome), { recursive: true });
    await fs.mkdir(chatsDir(deskHome), { recursive: true });
    await fs.mkdir(desktopDir(deskHome, agentId), { recursive: true });

    const toolSocket = process.env.DESK_TOOL_SOCKET;
    const binds = [
      ...containerBinds(deskHome, agentId),
      // Only mount the tool socket when it actually exists on the host. Binding
      // a non-existent path makes Docker create an empty directory there,
      // which then confuses the sandbox CLI. With the socket absent, the
      // in-sandbox CLI surfaces a clear "tool socket missing" error instead.
      ...(toolSocket ? [`${toolSocket}:/run/desk/tools.sock`] : []),
    ];

    const container = await docker.createContainer({
      name: containerName,
      Image: "desk/sandbox:v1",
      Env: [
        `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ?? ""}`,
      ],
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
    return { containerId: info.Id, agentId };
  }
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
