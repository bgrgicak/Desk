/**
 * Docker sandbox lifecycle management.
 * In v1: one sandbox per agent (one agent total).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROVIDER_KEY_VARS } from "@agent-desk/shared";
import { resolveDeskHome } from "@agent-desk/storage";
import {
  bindsFromPlan,
  buildDefaultMountPlan,
  type MountPlan,
} from "./mounts.js";

/**
 * Resolves the Docker socket path. Order of preference:
 *   1. DOCKER_HOST env var (unix:// only — TCP not supported here).
 *   2. `docker context inspect` for the current context.
 *   3. Linux default at /var/run/docker.sock.
 *   4. macOS Docker Desktop's per-user socket at ~/.docker/run/docker.sock.
 */
function resolveDockerSocket(): string {
  if (process.env.DOCKER_HOST) {
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
  const linuxDefault = "/var/run/docker.sock";
  if (fssync.existsSync(linuxDefault)) return linuxDefault;
  const macDesktop = path.join(os.homedir(), ".docker", "run", "docker.sock");
  if (fssync.existsSync(macDesktop)) return macDesktop;
  return linuxDefault;
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
  const Docker = (await import("dockerode")).default;
  const docker = new Docker({ socketPath: dockerSocketPath() });

  try {
    await docker.getImage("desk/sandbox:v1").inspect();
  } catch {
    console.warn(
      "desk/sandbox:v1 image not found. Build it from packages/server/runtime/Dockerfile.sandbox " +
      "or run `desk init` (if using @agent-desk/cli) to build it.",
    );
  }
}

/**
 * Creates or reuses a sandbox container for a workspace. One container per
 * workspace, any agent enrolled in the workspace execs through it.
 *
 * Reuse is guarded by a drift check: if the running container's image id
 * or bind layout no longer matches what the current code would produce,
 * it's torn down and recreated. Silent reuse of a drifted container (from
 * a rebuilt image or a changed MountPlan) previously masked real bugs for
 * days — a stale agent file inside an old container kept resolving a
 * long-removed model, while fresh host code had already moved on.
 *
 * `providerKeys` is an optional map of AI-provider credentials to inject as
 * env vars. When omitted the function falls back to reading the host env —
 * that legacy path is what tests without DB access use.
 */
export async function createOrReuse(
  workspaceId: string,
  workspaceSlug: string,
  home?: string,
  providerKeys?: Record<string, string>,
  mountPlan?: MountPlan,
): Promise<SandboxHandle> {
  const Docker = (await import("dockerode")).default;
  const docker = new Docker({ socketPath: dockerSocketPath() });
  const containerName = `desk-sandbox-${workspaceId}`;

  const deskHome = home ?? resolveDeskHome();
  const plan = mountPlan ?? buildDefaultMountPlan(deskHome, workspaceSlug);
  const expectedBinds = bindsFromPlan(plan);
  const expectedUser = sandboxUser();

  // Reuse the container only if its image, binds, and runtime user still
  // match the current expectation; otherwise tear it down and fall through
  // to the create path. Bind order isn't meaningful to Docker, so compare
  // as sets.
  try {
    const existing = docker.getContainer(containerName);
    const info = await existing.inspect();
    const currentImageId = await docker
      .getImage("desk/sandbox:v1")
      .inspect()
      .then((i) => i.Id)
      .catch(() => null);
    const imageMatches = currentImageId !== null && info.Image === currentImageId;
    const mountsMatch = bindsEqual(info.HostConfig?.Binds, expectedBinds);
    const userMatches = (info.Config?.User ?? "") === expectedUser;
    if (imageMatches && mountsMatch && userMatches) {
      if (!info.State.Running) await existing.start();
      return { containerId: info.Id, workspaceId };
    }
    await existing.remove({ force: true });
  } catch {
    // Not found — fall through to create.
  }

  // Pre-create every source dir in the plan so Docker doesn't auto-create
  // them as root and break subsequent non-root writes.
  for (const entry of plan) {
    await fs.mkdir(entry.sourcePath, { recursive: true });
  }

  const createSpec = {
    name: containerName,
    Image: "desk/sandbox:v1",
    // Run as the host user that owns the workspace bind. The image bakes
    // an `agent` user at UID 2000, but the workspace dir on disk is owned
    // by whoever runs desk-server; using their uid:gid keeps writes both
    // ways (host → sandbox and sandbox → host) without any chown dance.
    User: expectedUser,
    Env: providerKeyEnv(providerKeys),
    HostConfig: {
      CapDrop: ["ALL"],
      NetworkMode: "bridge",
      // host-gateway lets the in-sandbox `desk` CLI reach the host-side
      // desk-server REST API as `host.docker.internal`. The bridge default
      // gives the container an IP but no DNS name for the host, so without
      // this the agent has no route back to /sandbox/messages.
      ExtraHosts: ["host.docker.internal:host-gateway"],
      PidsLimit: 256,
      Memory: 512 * 1024 * 1024,
      Tmpfs: { "/tmp": "" },
      Binds: expectedBinds,
    },
  };
  let container;
  try {
    container = await docker.createContainer(createSpec);
  } catch (err) {
    // Race: two startSandbox() calls for the same workspace can both pass
    // the inspect() check (404 → not found) and both try to create. The
    // loser sees a 409 Conflict. The winner has already produced a usable
    // container with matching binds (we'd have reused it above otherwise),
    // so reuse it instead of failing the fire.
    if ((err as { statusCode?: number }).statusCode === 409) {
      const winner = docker.getContainer(containerName);
      const winnerInfo = await winner.inspect();
      if (!winnerInfo.State.Running) await winner.start();
      return { containerId: winnerInfo.Id, workspaceId };
    }
    throw err;
  }
  await container.start();
  const info = await container.inspect();
  return { containerId: info.Id, workspaceId };
}

/**
 * Returns the `User` value to pass to Docker — `<uid>:<gid>` that the
 * sandbox should run as.
 *
 * Rootful docker: the workspace bind-mount is owned by whoever runs
 * desk-server; running the sandbox as the same uid keeps reads/writes
 * symmetric without any chown dance. → use process uid/gid.
 *
 * Rootless docker: host uid N → container uid 0 (the daemon runner is
 * the user-namespace root). Files owned by the host user appear as
 * root:root inside the container, so the sandbox must run as 0:0 to
 * write through the bind. → use 0:0.
 *
 * Override via DESK_SANDBOX_USER for the rare case where neither rule
 * fits (CI matrices, custom docker daemons, etc).
 */
export function sandboxUser(): string {
  if (process.env.DESK_SANDBOX_USER) return process.env.DESK_SANDBOX_USER;
  if (isRootlessDocker()) return "0:0";
  // process.getuid()/getgid() are POSIX-only — undefined on Windows. We
  // never run desk-server on Windows, so the cast keeps types honest
  // without a runtime branch.
  const uid = (process.getuid?.() ?? 0);
  const gid = (process.getgid?.() ?? 0);
  return `${uid}:${gid}`;
}

let _rootlessCache: boolean | undefined;
/**
 * Detects whether the active docker context is rootless. Caches the result
 * because `docker info` adds ~150ms per call and the answer is stable for
 * the lifetime of the process.
 */
function isRootlessDocker(): boolean {
  if (_rootlessCache !== undefined) return _rootlessCache;
  try {
    const out = execFileSync(
      "docker", ["info", "--format", "{{.SecurityOptions}}"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] },
    );
    _rootlessCache = out.includes("rootless");
  } catch {
    _rootlessCache = false;
  }
  return _rootlessCache;
}

/** Order-insensitive equality for Docker bind-mount strings. */
function bindsEqual(actual: string[] | undefined, expected: string[]): boolean {
  if ((actual?.length ?? 0) !== expected.length) return false;
  const a = [...(actual ?? [])].sort();
  const e = [...expected].sort();
  for (let i = 0; i < a.length; i++) if (a[i] !== e[i]) return false;
  return true;
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
export function providerKeyEnv(keys?: Record<string, string>): string[] {
  const out: string[] = [];
  const source: Record<string, string | undefined> = keys ?? process.env;
  for (const name of PROVIDER_KEY_VARS) {
    const v = source[name];
    if (v && v.length > 0) out.push(`${name}=${v}`);
  }
  return out;
}

/**
 * Reports running sandbox containers whose bind sources don't begin with the
 * supplied DESK_HOME tree. Returned for boot-time logging so a regression in
 * the home-resolution path (which once silently dropped uploads into a
 * parallel tree) fails loud instead of corrupting state.
 *
 * Returns an empty array under the fake driver and on docker errors — this is
 * a best-effort check, not a gate.
 */
export interface SandboxBindDrift {
  containerName: string;
  expectedPrefix: string;
  actualBinds: string[];
}

export async function auditSandboxMounts(home: string): Promise<SandboxBindDrift[]> {
  const Docker = (await import("dockerode")).default;
  const docker = new Docker({ socketPath: dockerSocketPath() });
  const expectedPrefix = `${home}/Desk/workspaces/`;
  const drift: SandboxBindDrift[] = [];
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { name: ["desk-sandbox-"] },
    });
    for (const c of containers) {
      const name = (c.Names?.[0] ?? "").replace(/^\//, "");
      if (!name.startsWith("desk-sandbox-")) continue;
      let binds: string[] = [];
      try {
        const info = await docker.getContainer(c.Id).inspect();
        binds = info.HostConfig?.Binds ?? [];
      } catch {
        continue;
      }
      const workspaceBind = binds.find(
        (b) => b.endsWith(":/home/agent:rw") || b.endsWith(":/home/agent"),
      );
      if (!workspaceBind) continue;
      const source = workspaceBind.split(":")[0];
      if (!source.startsWith(expectedPrefix)) {
        drift.push({ containerName: name, expectedPrefix, actualBinds: binds });
      }
    }
  } catch {
    // Docker not reachable (dev without docker, CI, etc.) — best-effort only.
  }
  return drift;
}

/**
 * Stops a sandbox container.
 */
export async function stopSandbox(handle: SandboxHandle): Promise<void> {
  const Docker = (await import("dockerode")).default;
  const docker = new Docker({ socketPath: dockerSocketPath() });

  try {
    const container = docker.getContainer(handle.containerId);
    await container.stop({ t: 10 });
  } catch {
    // Container may already be stopped
  }
}
