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
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

const SANDBOX_PIDS_LIMIT = 2048;
const SANDBOX_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
const SANDBOX_TMPFS: Record<string, string> = { "/tmp": "size=1g" };
const SANDBOX_RESOURCE_PROFILE_LABEL = "agent-desk.sandbox-resource-profile";
const SANDBOX_AGENT_USER_LABEL = "agent-desk.sandbox-agent-user";
const SANDBOX_RESOURCE_PROFILE = "pids=2048,memory=4g,tmpfs=/tmp:size=1g,user=root+sudo";
const SANDBOX_CONTAINER_USER = "0:0";
const SANDBOX_READY_TIMEOUT_MS = 300_000;

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
 *
 * `extraEnv` carries non-key env vars (e.g. `OPENCODE_AUTH_CONTENT` for the
 * Codex/ChatGPT bridge) that should be present at container birth so the
 * first opencode invocation has the auth blob already wired up.
 */
export async function createOrReuse(
  workspaceId: string,
  workspaceSlug: string,
  home?: string,
  providerKeys?: Record<string, string>,
  mountPlan?: MountPlan,
  extraEnv?: Record<string, string>,
): Promise<SandboxHandle> {
  const engine = await detectEngine();
  const containerName = `desk-sandbox-${workspaceId}`;

  const deskHome = home ?? resolveDeskHome();
  const plan = mountPlan ?? buildDefaultMountPlan(deskHome, workspaceSlug);
  const expectedBindStrings = bindsFromPlan(plan);
  const expectedBinds = parseBindStrings(expectedBindStrings);
  const expectedUser = SANDBOX_CONTAINER_USER;
  const agentUser = await sandboxUser(engine);

  // Reuse the container only if its image, binds, container user, and agent
  // user still match the current expectation; otherwise tear it down and fall
  // through to the create path. Bind order isn't meaningful, compare as sets.
  const existing = await engine.inspect(containerName);
  if (existing) {
    const currentImageId = await engine.imageId(sandboxImage());
    const imageMatches = currentImageId !== null && existing.imageId === currentImageId;
    const mountsMatch = bindsEqual(existing.binds, expectedBindStrings);
    const userMatches = existing.user === expectedUser;
    const resourcesMatch = existing.labels[SANDBOX_RESOURCE_PROFILE_LABEL] === SANDBOX_RESOURCE_PROFILE;
    const agentUserMatches = existing.labels[SANDBOX_AGENT_USER_LABEL] === agentUser;
    if (imageMatches && mountsMatch && userMatches && resourcesMatch && agentUserMatches) {
      if (!existing.running) await engine.start(containerName);
      await waitForEntrypointReady(engine, existing.id);
      return { containerId: existing.id, workspaceId };
    }
    await engine.remove(containerName, true);
  }

  // Pre-create every source dir and nested target mount point so the runtime
  // doesn't auto-create them as root and break subsequent non-root writes.
  for (const entry of plan) {
    await fs.mkdir(entry.sourcePath, { recursive: true });
  }
  await ensureNestedMountTargets(plan);

  try {
    const containerId = await engine.create({
      name: containerName,
      image: sandboxImage(),
      // Start the long-lived container as root so the entrypoint can wire up
      // the per-host `agent` user and passwordless sudo. Individual agent
      // execs still run as `sandboxUser()` below, keeping normal workspace
      // writes owned by the host user on rootful Docker.
      user: expectedUser,
      env: [
        ...providerKeyEnv(providerKeys, extraEnv),
        `DESK_SANDBOX_AGENT_USER=${agentUser}`,
      ],
      labels: {
        [SANDBOX_RESOURCE_PROFILE_LABEL]: SANDBOX_RESOURCE_PROFILE,
        [SANDBOX_AGENT_USER_LABEL]: agentUser,
      },
      network: "bridge",
      // host-gateway lets the in-sandbox `desk` CLI reach the host-side
      // desk-server REST API as `host.docker.internal`. Without it the
      // bridge default has no DNS name for the host, so the agent has no
      // route back to /sandbox/messages.
      extraHosts: ["host.docker.internal:host-gateway"],
      // Modern JS tooling routinely uses worker threads and forked helper
      // processes; keep a real blast-radius limit without blocking builds.
      pidsLimit: SANDBOX_PIDS_LIMIT,
      // 4 GiB — opencode + node + the LLM SDK plus enough headroom for Vite,
      // Tailwind, Vitest, and package-manager subprocesses.
      memoryBytes: SANDBOX_MEMORY_BYTES,
      tmpfs: SANDBOX_TMPFS,
      binds: expectedBinds,
    });
    await waitForEntrypointReady(engine, containerId);
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
        await waitForEntrypointReady(engine, winner.id);
        return { containerId: winner.id, workspaceId };
      }
    }
    throw err;
  }
}

async function waitForEntrypointReady(engine: Engine, containerId: string): Promise<void> {
  const deadline = Date.now() + SANDBOX_READY_TIMEOUT_MS;
  let lastStderr = "";
  while (Date.now() < deadline) {
    const handle = await engine.exec({
      containerId,
      cmd: ["test", "-f", "/tmp/desk-entrypoint-ready"],
      user: SANDBOX_CONTAINER_USER,
    });
    const stderr: Buffer[] = [];
    handle.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exitCode = await handle.wait();
    if (exitCode === 0) return;
    lastStderr = Buffer.concat(stderr).toString("utf8");
    await delay(250);
  }

  throw new Error(
    `Sandbox entrypoint did not become ready within ${SANDBOX_READY_TIMEOUT_MS}ms${lastStderr ? `: ${lastStderr}` : ""}`,
  );
}

async function ensureNestedMountTargets(plan: MountPlan): Promise<void> {
  for (const entry of plan) {
    for (const parent of plan) {
      if (entry === parent) continue;
      if (parent.category !== "workspace" || parent.mode !== "rw") continue;
      const rel = path.posix.relative(parent.targetPath, entry.targetPath);
      if (!rel || rel.startsWith("..") || path.posix.isAbsolute(rel)) continue;
      await fs.mkdir(path.join(parent.sourcePath, rel), { recursive: true });
    }
  }
}

/**
 * Returns `<uid>:<gid>` that agent commands should run as.
 *
 * Rootful runtime: the workspace bind-mount is owned by whoever runs
 * desk-server; running agent execs as the same uid keeps reads/writes
 * symmetric without any chown dance. → use process uid/gid.
 *
 * Rootless runtime: host uid N → container uid 0 (the daemon runner is
 * the user-namespace root). Files owned by the host user appear as
 * root:root inside the container, so agent execs must run as 0:0 to
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
 * `extraEnv` is emitted as-is, bypassing the PROVIDER_KEY_VARS allowlist.
 * Use it for non-key credentials such as `OPENCODE_AUTH_CONTENT`, which
 * carry their own validation contract (the value is an opaque OAuth blob,
 * not a per-provider key name).
 *
 * Only keys with non-empty values are emitted, so opencode's auto-detection
 * doesn't light up empty providers.
 */
export function providerKeyEnv(
  keys?: Record<string, string>,
  extraEnv?: Record<string, string>,
): string[] {
  const out: string[] = [];
  const source: Record<string, string | undefined> = keys ?? process.env;
  for (const name of PROVIDER_KEY_VARS) {
    const v = source[name];
    if (v && v.length > 0) out.push(`${name}=${v}`);
  }
  if (extraEnv) {
    for (const [name, value] of Object.entries(extraEnv)) {
      if (value && value.length > 0) out.push(`${name}=${value}`);
    }
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
  // Workspaces sit directly under DESK_HOME — a legitimate bind source has
  // `home` as its parent directory. Containers from the legacy `workspaces/`
  // layout (parent `${home}/workspaces`) get pruned along with any DESK_HOME
  // drift in the same check.
  const expectedParent = home.replace(/\/+$/, "");
  const expectedPrefix = `${expectedParent}/`;
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
      const source = workspaceBind.split(":")[0].replace(/\/+$/, "");
      if (path.dirname(source) !== expectedParent) {
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

/**
 * Removes containers reported by auditSandboxMounts as having stale bind
 * mounts. Safe to call at startup: drifted containers are unusable (their
 * workspace path no longer matches DESK_HOME), so removing them lets the
 * next run create a fresh container with the correct mounts rather than
 * waiting for getOrCreateSandbox to detect the mismatch at call time.
 */
export async function pruneDriftedContainers(drift: SandboxBindDrift[]): Promise<void> {
  if (drift.length === 0) return;
  try {
    const engine = await detectEngine();
    await Promise.all(
      drift.map(async (d) => {
        try {
          await engine.remove(d.containerName);
        } catch {
          // Already removed or engine error — best-effort.
        }
      }),
    );
  } catch {
    // Engine not reachable.
  }
}
