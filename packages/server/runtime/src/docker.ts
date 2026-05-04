/**
 * Sandbox container lifecycle — engine-agnostic.
 *
 * The actual `docker` / `nerdctl` shell-out lives in `engine.ts`. This
 * module is the high-level "one sandbox per workspace" policy on top of
 * that: image bootstrap, create-or-reuse with drift detection, mount
 * audit, stop. The file is still named `docker.ts` for git history; the
 * abstraction it implements is "container sandbox", not specifically
 * Docker.
 */

import * as fs from "node:fs/promises";
import { PROVIDER_KEY_VARS } from "@agent-desk/shared";
import { resolveDeskHome } from "@agent-desk/storage";
import {
  bindsFromPlan,
  buildDefaultMountPlan,
  type MountPlan,
} from "./mounts.js";
import { detectEngine, type BindMount, type Engine } from "./engine.js";

/**
 * The sandbox container image used for every desk-agent run. Resolves
 * lazily so a test can flip DESK_SANDBOX_IMAGE between cases (the value
 * is read on every call rather than cached at import time).
 *
 * Default `desk/sandbox:v1` matches what `docker build -t desk/sandbox:v1
 * packages/server/runtime/Dockerfile.sandbox` produces — the path
 * documented in the README. The CLI overrides this in published mode to
 * a registry-published, version-pinned tag (see §4 of npm-publish.md).
 */
export function sandboxImage(): string {
  return process.env.DESK_SANDBOX_IMAGE ?? "desk/sandbox:v1";
}

export interface SandboxHandle {
  containerId: string;
  /** Workspace this sandbox belongs to. One sandbox per workspace; any of the workspace's agents can exec through it. */
  workspaceId: string;
}

/**
 * Ensures the sandbox image exists locally. If absent, attempts a pull —
 * the published-install path where the image lives on a registry but
 * hasn't been pulled yet. In monorepo dev the image is built locally
 * from the in-tree Dockerfile, so the pull fails cleanly and we log a
 * warning that points at the build command.
 */
export async function ensureImage(): Promise<void> {
  const engine = await detectEngine();
  const image = sandboxImage();
  if (await engine.imageId(image)) return;
  try {
    await engine.imagePull(image, (line) => {
      process.stderr.write(`pull ${image}: ${line}\n`);
    });
  } catch (err) {
    console.warn(
      `${image} image not found locally and pull failed (${(err as Error).message}). ` +
        "If this is a monorepo dev checkout, build the image from " +
        "packages/server/runtime/Dockerfile.sandbox.",
    );
  }
}

/**
 * Creates or reuses a sandbox container for a workspace. One container per
 * workspace, any agent enrolled in the workspace execs through it.
 *
 * Reuse is guarded by a drift check: if the running container's image id,
 * bind layout, or runtime user no longer matches what the current code
 * would produce, it's torn down and recreated. Silent reuse of a drifted
 * container previously masked real bugs for days — a stale agent file
 * inside an old container kept resolving a long-removed model, while
 * fresh host code had already moved on.
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
  const engine = await detectEngine();
  const containerName = `desk-sandbox-${workspaceId}`;

  const deskHome = home ?? resolveDeskHome();
  const plan = mountPlan ?? buildDefaultMountPlan(deskHome, workspaceSlug);
  const expectedBindStrings = bindsFromPlan(plan);
  const expectedBinds = parseBindStrings(expectedBindStrings);
  const expectedUser = await sandboxUser(engine);

  // Reuse the container only if its image, binds, and runtime user still
  // match the current expectation; otherwise tear it down and fall through
  // to the create path. Bind order isn't meaningful, compare as sets.
  const existing = await engine.inspect(containerName);
  if (existing) {
    const currentImageId = await engine.imageId(sandboxImage());
    const imageMatches = currentImageId !== null && existing.imageId === currentImageId;
    const mountsMatch = bindsEqual(existing.binds, expectedBindStrings);
    const userMatches = existing.user === expectedUser;
    if (imageMatches && mountsMatch && userMatches) {
      if (!existing.running) await engine.start(containerName);
      return { containerId: existing.id, workspaceId };
    }
    await engine.remove(containerName, true);
  }

  // Pre-create every source dir in the plan so the runtime doesn't
  // auto-create them as root and break subsequent non-root writes.
  for (const entry of plan) {
    await fs.mkdir(entry.sourcePath, { recursive: true });
  }

  try {
    const containerId = await engine.create({
      name: containerName,
      image: sandboxImage(),
      // Run as the host user that owns the workspace bind. The image bakes
      // an `agent` user at UID 2000, but the workspace dir on disk is owned
      // by whoever runs desk-server; using their uid:gid keeps writes both
      // ways (host → sandbox and sandbox → host) without any chown dance.
      user: expectedUser,
      env: providerKeyEnv(providerKeys),
      capDrop: ["ALL"],
      network: "bridge",
      // host-gateway lets the in-sandbox `desk` CLI reach the host-side
      // desk-server REST API as `host.docker.internal`. Without it the
      // bridge default has no DNS name for the host, so the agent has no
      // route back to /sandbox/messages.
      extraHosts: ["host.docker.internal:host-gateway"],
      pidsLimit: 256,
      memoryBytes: 512 * 1024 * 1024,
      tmpfs: { "/tmp": "" },
      binds: expectedBinds,
    });
    return { containerId, workspaceId };
  } catch (err) {
    // Race: two startSandbox() calls for the same workspace can both pass
    // the inspect() check (no container) and both try to create. The
    // loser sees a name conflict. The winner has a usable container with
    // matching binds (we'd have reused it above otherwise), so reuse
    // it instead of failing the fire.
    if ((err as { conflict?: boolean }).conflict) {
      const winner = await engine.inspect(containerName);
      if (winner) {
        if (!winner.running) await engine.start(containerName);
        return { containerId: winner.id, workspaceId };
      }
    }
    throw err;
  }
}

/**
 * Returns `<uid>:<gid>` that the sandbox should run as.
 *
 * Rootful runtime: the workspace bind-mount is owned by whoever runs
 * desk-server; running the sandbox as the same uid keeps reads/writes
 * symmetric without any chown dance. → use process uid/gid.
 *
 * Rootless runtime: host uid N → container uid 0 (the daemon runner is
 * the user-namespace root). Files owned by the host user appear as
 * root:root inside the container, so the sandbox must run as 0:0 to
 * write through the bind. → use 0:0.
 *
 * Override via DESK_SANDBOX_USER for the rare case where neither rule
 * fits (CI matrices, custom daemons, etc).
 */
export async function sandboxUser(engine?: Engine): Promise<string> {
  if (process.env.DESK_SANDBOX_USER) return process.env.DESK_SANDBOX_USER;
  const e = engine ?? (await detectEngine());
  if (await e.isRootless()) return "0:0";
  // process.getuid()/getgid() are POSIX-only — undefined on Windows. We
  // never run desk-server on Windows, so the cast keeps types honest
  // without a runtime branch.
  const uid = (process.getuid?.() ?? 0);
  const gid = (process.getgid?.() ?? 0);
  return `${uid}:${gid}`;
}

/** Order-insensitive equality for bind-mount strings. */
function bindsEqual(actual: string[] | undefined, expected: string[]): boolean {
  if ((actual?.length ?? 0) !== expected.length) return false;
  const a = [...(actual ?? [])].sort();
  const e = [...expected].sort();
  for (let i = 0; i < a.length; i++) if (a[i] !== e[i]) return false;
  return true;
}

/**
 * `bindsFromPlan` returns docker-style strings (`src:dst:mode`); engine
 * `create()` wants structured `BindMount` records. Translate without
 * losing the mode (defaults to `rw` if unspecified).
 */
function parseBindStrings(strings: string[]): BindMount[] {
  return strings.map((s) => {
    const parts = s.split(":");
    const mode = parts.length >= 3 && parts[parts.length - 1] === "ro" ? "ro" : "rw";
    return { source: parts[0], target: parts[1], mode };
  });
}

/**
 * Formats AI-provider credentials as engine env entries.
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
 * Returns an empty array under the fake driver and on engine errors — this
 * is a best-effort check, not a gate.
 */
export interface SandboxBindDrift {
  containerName: string;
  expectedPrefix: string;
  actualBinds: string[];
}

export async function auditSandboxMounts(home: string): Promise<SandboxBindDrift[]> {
  const expectedPrefix = `${home}/Desk/workspaces/`;
  const drift: SandboxBindDrift[] = [];
  try {
    const engine = await detectEngine();
    const containers = await engine.list({ all: true, namePrefix: "desk-sandbox-" });
    for (const c of containers) {
      if (!c.name.startsWith("desk-sandbox-")) continue;
      let info;
      try {
        info = await engine.inspect(c.id);
      } catch {
        continue;
      }
      if (!info) continue;
      const workspaceBind = info.binds.find(
        (b) => b.endsWith(":/home/agent:rw") || b.endsWith(":/home/agent"),
      );
      if (!workspaceBind) continue;
      const source = workspaceBind.split(":")[0];
      if (!source.startsWith(expectedPrefix)) {
        drift.push({ containerName: c.name, expectedPrefix, actualBinds: info.binds });
      }
    }
  } catch {
    // Engine not reachable (dev without docker/nerdctl, CI without either) —
    // best-effort only.
  }
  return drift;
}

/** Stops a sandbox container. Idempotent. */
export async function stopSandbox(handle: SandboxHandle): Promise<void> {
  try {
    const engine = await detectEngine();
    await engine.stop(handle.containerId, 10);
  } catch {
    // Container may already be stopped or engine unreachable.
  }
}
