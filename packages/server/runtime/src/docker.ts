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
import {
  CONNECTION_ENV_VARS,
  MANAGED_CONNECTION_ENV_ALIASES,
  managedConnectionDefinitions,
  PROVIDER_KEY_VARS,
  SANDBOX_CONNECTION_ENV_VARS,
} from "@agent-desk/shared";
import { resolveDeskHome } from "@agent-desk/storage";
import {
  bindsFromPlan,
  buildDefaultMountPlan,
  type MountPlan,
} from "./mounts.js";
import { detectEngine, type BindMount, type Engine } from "./engine.js";
import { OPENCODE_SERVE_CONTAINER_PORT } from "./opencodeServer.js";

import type { WorkspaceKind } from "@agent-desk/shared";

/**
 * The sandbox container image used for a desk-agent run. Resolves lazily
 * so a test can flip DESK_SANDBOX_IMAGE between cases (the value is
 * read on every call rather than cached at import time).
 *
 * `kind` lets the hub take a different image than project workspaces
 * once a distinct hub image is built. Today they resolve to the same
 * image — the env hook is wired up but falls back to
 * `DESK_SANDBOX_IMAGE` so a divergence is one env-var flip away. The
 * default `desk/sandbox:v1` matches what
 * `docker build -t desk/sandbox:v1 packages/server/runtime/Dockerfile.sandbox`
 * produces (documented in the README). The CLI overrides this in
 * published mode to a registry-published, version-pinned tag (see §4 of
 * npm-publish.md).
 */
export function sandboxImage(kind: WorkspaceKind = "project"): string {
  if (kind === "hub") {
    return (
      process.env.DESK_HUB_SANDBOX_IMAGE ??
      process.env.DESK_SANDBOX_IMAGE ??
      "desk/sandbox:v1"
    );
  }
  return process.env.DESK_SANDBOX_IMAGE ?? "desk/sandbox:v1";
}

export interface SandboxHandle {
  containerId: string;
  /** Workspace this sandbox belongs to. One sandbox per workspace; any of the workspace's agents can exec through it. */
  workspaceId: string;
}

/**
 * Sandbox resource sizing.
 *
 * Every sandbox starts at the baseline. When a run fails with a
 * resource-shaped error (`spawn EAGAIN`, OOM-kill, etc.) the scheduler
 * calls `growSandboxForResourceError` to double the pressured dimension
 * in place via `docker update`, capped at the maximum. No profiles, no
 * tiers — just two pairs of numbers and a "double on demand" rule.
 *
 * The numbers were measured from real sandbox baseline (5 PIDs / ~50 MB
 * idle, ~20 PIDs / 300-400 MB during a chat run, ~50-100 PIDs / ~1 GB
 * for site/app work with firefox). 512 / 512 MB is comfortably above
 * idle, ~50 % headroom for chat work, and growth handles the rest.
 */
const SANDBOX_BASELINE_PIDS = 512;
const SANDBOX_BASELINE_MEMORY_BYTES = 512 * 1024 * 1024;
const SANDBOX_MAX_PIDS = 4096;
const SANDBOX_MAX_MEMORY_BYTES = 8 * 1024 * 1024 * 1024;
const SANDBOX_TMPFS: Record<string, string> = { "/tmp": "size=512m" };
const SANDBOX_RESOURCE_PROFILE_LABEL = "agent-desk.sandbox-resource-profile";
const SANDBOX_AGENT_USER_LABEL = "agent-desk.sandbox-agent-user";
const SANDBOX_CONTAINER_USER = "0:0";
const SANDBOX_READY_TIMEOUT_MS = 300_000;

/**
 * Identity tag for the sandbox runtime contract. Bumped whenever a
 * runtime-fundamental feature changes (e.g. tini PID 1, mount layout,
 * user model) so old containers fail drift and get recreated *once*.
 *
 * **Deliberately omits the size profile.** Size used to be encoded here
 * and that turned out to be catastrophic: two chats with different goals
 * in the same workspace would fight over the container size, drift-
 * recreating on every alternation and racing all other concurrent runs
 * into "container name already in use". A sandbox should be a stable
 * shared resource that any chat in the workspace can exec through,
 * regardless of size preference. Size is now a first-create-only
 * decision; growing an existing sandbox is a follow-up (see
 * `packages/server/docs/plans/sandbox-autoscaling.md`).
 */
const SANDBOX_RUNTIME_TAG = "opencode-serve-v1";

function resourceProfileString(): string {
  return `runtime=${SANDBOX_RUNTIME_TAG},user=root+sudo`;
}

/**
 * Resource-shaped failure modes the scheduler can recover from by
 * growing the sandbox and re-firing the message. Anything else is a
 * real run failure that propagates to the user.
 */
export type ResourceFailureKind = "pids" | "memory";

/**
 * Classifies a finished run's exit code + stderr (or buffered log text)
 * as a sandbox resource exhaustion, or null if the failure is something
 * else we shouldn't retry. We're deliberately conservative: a bad regex
 * here means we retry a non-resource error in a loop, which is worse
 * than surfacing a one-off transient.
 */
export function classifyResourceError(
  exitCode: number,
  stderr: string,
): ResourceFailureKind | null {
  if (exitCode === 0) return null;
  // SIGKILL exit code. The cgroup OOM-killer fires SIGKILL when memory
  // is over limit; nothing else routinely produces 137 on a successful
  // CLI binary, so we treat it as an OOM signal.
  if (exitCode === 137) return "memory";
  const s = stderr.toLowerCase();
  // Bun and Node both surface fork-limit hits as "spawn ... EAGAIN" or
  // "Resource temporarily unavailable". Both mean the pids cgroup is
  // exhausted — `man 2 fork` lists EAGAIN as "system-imposed limit on
  // the number of processes was reached."
  if (/\bspawn\b[\s\S]*\beagain\b/i.test(s)) return "pids";
  if (s.includes("resource temporarily unavailable")) return "pids";
  if (s.includes("fork: retry") || /\bfork failed\b/.test(s)) return "pids";
  // Out-of-memory pattern from Bun, Node, libc malloc, etc.
  if (s.includes("enomem")) return "memory";
  if (s.includes("out of memory")) return "memory";
  if (s.includes("cannot allocate memory")) return "memory";
  // setsid (util-linux) wraps the opencode exec for process-group cleanup.
  // Older setsid versions report a signal-killed child as
  //   `setsid: child <pid> did not exit normally: Success`
  // and exit 1 — so a cgroup OOM-kill (SIGKILL) reaches the runtime as
  // exit 1 + this stderr line, never as the canonical 137 above. Without
  // recognising it, the auto-grow path never fires for OOMs under the
  // setsid wrapper. The stderr line is specific enough to be unambiguous;
  // a non-OOM signal kill that hits this path will at worst grow the
  // sandbox once before the user-visible failure surfaces.
  if (s.includes("setsid:") && s.includes("did not exit normally")) return "memory";
  // opencode-serve daemon mid-run failure: HTTP calls to a dead daemon
  // surface as `fetch failed` / `ECONNREFUSED` in stderr, not as a
  // child-process exit code. The driver probes the container's cgroup
  // `memory.events.oom_kill` after a daemon-gone error and emits a
  // marker line when the kernel actually OOM-killed it. That's the
  // signal the auto-scaler needs to grow memory before retry instead
  // of failing the user with no recovery.
  if (s.includes("opencode-serve was oom-killed")) return "memory";
  return null;
}

/**
 * Per-container in-flight growth. When two runs fail simultaneously
 * from the same OOM event, the first to call `growSandboxForResourceError`
 * stores its in-progress Promise here; subsequent callers await it
 * instead of double-growing the sandbox.
 *
 * Keyed by sandbox container name (stable across the run) rather than
 * id, so concurrent fires before the second `inspect` agree on the
 * lock target.
 */
const growthInFlight = new Map<string, Promise<GrowthResult>>();

/** Test-only: clears the in-flight-growth lock and any related state. */
export function _resetGrowthStateForTest(): void {
  growthInFlight.clear();
}

export interface GrowthResult {
  /** True if either limit was raised; false if the container was already at the max. */
  grew: boolean;
  /** Limit dimension that was actually raised; null when `grew=false`. */
  dimension: ResourceFailureKind | null;
  /** Post-update pids limit (current or new). */
  pidsLimit: number;
  /** Post-update memory limit in bytes (current or new). */
  memoryBytes: number;
  /** True when the sandbox is already at the max for the requested dimension. */
  atMax: boolean;
}

/**
 * Doubles the pressured dimension on `workspaceId`'s sandbox in place
 * via `engine.update`. Coordinates concurrent failures so a single
 * grow happens per OOM event even when multiple runs die at once.
 *
 * Returns a `GrowthResult` describing what happened. A `grew=false,
 * atMax=true` result means the scheduler should surface the failure
 * to the user instead of retrying.
 */
export async function growSandboxForResourceError(
  workspaceId: string,
  kind: ResourceFailureKind,
): Promise<GrowthResult> {
  const containerName = `desk-sandbox-${workspaceId}`;
  const existing = growthInFlight.get(containerName);
  if (existing) return existing;
  const work = (async (): Promise<GrowthResult> => {
    const engine = await detectEngine();
    const info = await engine.inspect(containerName);
    if (!info || !info.pidsLimit || !info.memoryBytes) {
      // Container is gone (was removed mid-run) or has no cgroup limits
      // configured. Either way, nothing useful to update — bail.
      return {
        grew: false,
        dimension: null,
        pidsLimit: info?.pidsLimit ?? 0,
        memoryBytes: info?.memoryBytes ?? 0,
        atMax: false,
      };
    }
    if (kind === "pids") {
      if (info.pidsLimit >= SANDBOX_MAX_PIDS) {
        return { grew: false, dimension: "pids", pidsLimit: info.pidsLimit, memoryBytes: info.memoryBytes, atMax: true };
      }
      const next = Math.min(info.pidsLimit * 2, SANDBOX_MAX_PIDS);
      const ok = await engine.update(containerName, { pidsLimit: next });
      console.info(
        `sandbox ${containerName} grew pids ${info.pidsLimit} → ${next} after resource failure (engine accepted=${ok})`,
      );
      return { grew: ok, dimension: "pids", pidsLimit: ok ? next : info.pidsLimit, memoryBytes: info.memoryBytes, atMax: false };
    }
    // memory
    if (info.memoryBytes >= SANDBOX_MAX_MEMORY_BYTES) {
      return { grew: false, dimension: "memory", pidsLimit: info.pidsLimit, memoryBytes: info.memoryBytes, atMax: true };
    }
    const nextMem = Math.min(info.memoryBytes * 2, SANDBOX_MAX_MEMORY_BYTES);
    const ok = await engine.update(containerName, { memoryBytes: nextMem });
    console.info(
      `sandbox ${containerName} grew memory ${info.memoryBytes} → ${nextMem} after resource failure (engine accepted=${ok})`,
    );
    return { grew: ok, dimension: "memory", pidsLimit: info.pidsLimit, memoryBytes: ok ? nextMem : info.memoryBytes, atMax: false };
  })();
  growthInFlight.set(containerName, work);
  try {
    return await work;
  } finally {
    growthInFlight.delete(containerName);
  }
}

/**
 * Ensures the sandbox image exists locally. If absent, attempts a pull —
 * the published-install path where the image lives on a registry but
 * hasn't been pulled yet. In monorepo dev the image is built locally
 * from the in-tree Dockerfile, so the pull fails cleanly and we log a
 * warning that points at the build command.
 */
export async function ensureImage(kind: WorkspaceKind = "project"): Promise<void> {
  const engine = await detectEngine();
  const image = sandboxImage(kind);
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
 * create-time env vars. Sandbox tool connection tokens are intentionally not
 * baked into the long-lived container config; they are injected per exec.
 * When omitted the function falls back to reading the host env — that legacy
 * path is what tests without DB access use.
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
  workspaceKind: WorkspaceKind = "project",
): Promise<SandboxHandle> {
  const engine = await detectEngine();
  const containerName = `desk-sandbox-${workspaceId}`;
  const expectedResourceProfile = resourceProfileString();

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
    const currentImageId = await engine.imageId(sandboxImage(workspaceKind));
    const imageMatches = currentImageId !== null && existing.imageId === currentImageId;
    const mountsMatch = bindsEqual(existing.binds, expectedBindStrings);
    const userMatches = existing.user === expectedUser;
    const resourcesMatch = existing.labels[SANDBOX_RESOURCE_PROFILE_LABEL] === expectedResourceProfile;
    const agentUserMatches = existing.labels[SANDBOX_AGENT_USER_LABEL] === agentUser;
    if (imageMatches && mountsMatch && userMatches && resourcesMatch && agentUserMatches) {
      if (!existing.running) await engine.start(containerName);
      await waitForEntrypointReady(engine, existing.id);
      // Note: we never resize on plain reuse. Sandboxes start at the
      // baseline and only grow when a run actually fails with a
      // resource-shaped error — see `growSandboxForResourceError`. A
      // re-use that *would* benefit from a larger sandbox surfaces that
      // need by failing first, which is the correct signal.
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
      image: sandboxImage(workspaceKind),
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
        [SANDBOX_RESOURCE_PROFILE_LABEL]: expectedResourceProfile,
        [SANDBOX_AGENT_USER_LABEL]: agentUser,
      },
      network: "bridge",
      // host-gateway lets the in-sandbox `desk` CLI reach the host-side
      // desk-server REST API as `host.docker.internal`. Without it the
      // bridge default has no DNS name for the host, so the agent has no
      // route back to /sandbox/messages.
      extraHosts: ["host.docker.internal:host-gateway"],
      pidsLimit: SANDBOX_BASELINE_PIDS,
      memoryBytes: SANDBOX_BASELINE_MEMORY_BYTES,
      tmpfs: SANDBOX_TMPFS,
      binds: expectedBinds,
      // Publish the in-container `opencode serve` port to a host-auto-
      // assigned port on 127.0.0.1. The driver reads the assigned port
      // back via `engine.port()` and uses it to reach the per-sandbox
      // opencode daemon over HTTP/SSE. Bumping SANDBOX_RUNTIME_TAG ensures
      // pre-existing containers without this publish fail the drift check
      // and get recreated once on first use.
      ports: [{ containerPort: OPENCODE_SERVE_CONTAINER_PORT, hostIp: "127.0.0.1" }],
      // Docker's `--init` (bundled tini) becomes PID 1 and reaps reparented
      // children. The sandbox CMD is `sleep infinity`, which never reaps,
      // so without this every npx/esbuild/playwright child that exits
      // after its parent leaks a `<defunct>` slot until the container is
      // restarted. The flag is part of the resource profile string above,
      // so an old container created without it fails the drift check.
      init: true,
    });
    await waitForEntrypointReady(engine, containerId);
    return { containerId, workspaceId };
  } catch (err) {
    // Race: two startSandbox() calls for the same workspace can both pass
    // the inspect() check (no container) and both try to create. The
    // loser sees a name conflict. The winner has a usable container with
    // matching binds (we'd have reused it above otherwise), so reuse
    // it instead of failing the fire.
    //
    // The first inspect-after-conflict can briefly return null on dockerd
    // when the winning `docker run` has registered the name but the
    // container isn't fully created yet, so the loser sees neither
    // "exists" nor a fresh slot. Poll for up to ~2 s before giving up.
    if ((err as { conflict?: boolean }).conflict) {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const winner = await engine.inspect(containerName);
        if (winner) {
          if (!winner.running) await engine.start(containerName);
          await waitForEntrypointReady(engine, winner.id);
          return { containerId: winner.id, workspaceId };
        }
        await delay(100);
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
 * Formats AI-provider credentials as engine env entries for container create.
 *
 * With `keys` provided, uses that map (intersected with PROVIDER_KEY_VARS to
 * avoid leaking unrelated env into the container). Without, falls back to
 * the host process env — a legacy path for tests and dev flows that haven't
 * moved to DB-backed keys yet.
 *
 * `extraEnv` is emitted after filtering out managed connection key names.
 * Use it for non-key credentials such as `OPENCODE_AUTH_CONTENT`, which carry
 * their own validation contract (the value is an opaque OAuth blob, not a
 * per-provider key name).
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
  appendExtraEnv(out, extraEnv);
  return out;
}

/**
 * Per-run env vars sourced from Desk's connector resolver but not exposed
 * through Settings' generic /me/providers surface. Empty for now —
 * connectors that need ad-hoc minted tokens can append here.
 */
const TOOL_CONNECTION_ENV_VARS: readonly string[] = [] as const;

const MANAGED_CONNECTION_ENV_NAMES = new Set<string>([
  ...CONNECTION_ENV_VARS,
  ...MANAGED_CONNECTION_ENV_ALIASES,
  ...TOOL_CONNECTION_ENV_VARS,
]);

function appendExtraEnv(out: string[], extraEnv?: Record<string, string>): void {
  if (!extraEnv) return;
  for (const [name, value] of Object.entries(extraEnv)) {
    if (MANAGED_CONNECTION_ENV_NAMES.has(name)) continue;
    if (value && value.length > 0) out.push(`${name}=${value}`);
  }
}

function sandboxConnectionEnv(keys?: Record<string, string>): string[] {
  const out: string[] = [];
  if (!keys) return out;
  const source: Record<string, string | undefined> = keys;
  for (const name of [...SANDBOX_CONNECTION_ENV_VARS, ...TOOL_CONNECTION_ENV_VARS]) {
    const v = source[name];
    if (v && v.length > 0) out.push(`${name}=${v}`);
  }
  return out;
}

/**
 * Formats per-exec credential env for agent runs.
 *
 * A long-lived sandbox may have inherited legacy host env at container create
 * time. When the caller supplies the current vault-backed key map, explicitly
 * clear any allowed persisted connection env var that is absent so deleted/
 * disabled connections cannot leak back in from the warm container environment.
 *
 * Tool-only credentials are minted per run and are never written into the
 * container's create-time environment. When they cannot be resolved, omit
 * them rather than emitting an empty value; that lets callers and tools
 * distinguish "no token was minted" from a deliberately blanked persisted
 * secret.
 */
export function providerKeyExecEnv(
  keys?: Record<string, string>,
  extraEnv?: Record<string, string>,
): string[] {
  const out = [
    ...providerKeyEnv(keys),
    ...sandboxConnectionEnv(keys),
  ];
  appendExtraEnv(out, extraEnv);
  if (!keys) return out;

  const emitted = new Set(out.map((entry) => entry.slice(0, entry.indexOf("="))));
  for (const name of CONNECTION_ENV_VARS) {
    if (!emitted.has(name)) out.push(`${name}=`);
  }

  for (const definition of managedConnectionDefinitions()) {
    for (const alias of definition.envAliases ?? []) {
      out.push(`${alias}=${keys[definition.envKey] ?? ""}`);
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

/**
 * Removes any `desk-sandbox-*` container whose workspace has had no
 * `state='running'` rows and no message activity in the last `idleMs`.
 * The next fire's `createOrReuse` builds a fresh container at the
 * baseline 512 / 512 MB — so this also naturally resets a grown
 * sandbox back to the smallest size.
 *
 * `recentlyActiveWorkspaceIds` is supplied by the caller (typically
 * from a DB query) so this module stays DB-agnostic. Containers younger
 * than `minAgeMs` are skipped to protect against the race window between
 * a fire's `createOrReuse` and the next sweep — without this guard, a
 * brand-new container belonging to a workspace whose `messages.updated_at`
 * hasn't been bumped yet can be yanked out from under the in-flight fire.
 * Returns the names of containers it removed so callers can log / test.
 */
export async function reapIdleSandboxes(
  recentlyActiveWorkspaceIds: ReadonlySet<string>,
  minAgeMs: number = 5 * 60 * 1000,
): Promise<string[]> {
  const removed: string[] = [];
  let engine: Engine;
  try {
    engine = await detectEngine();
  } catch {
    return removed; // engine not reachable — best-effort
  }
  let containers: Array<{ id: string; name: string }>;
  try {
    containers = await engine.list({ namePrefix: "desk-sandbox-", all: false });
  } catch {
    return removed;
  }
  const now = Date.now();
  for (const c of containers) {
    // Skip transient reflection sandboxes — they have their own
    // workspace ids and own short lifecycles; a reaper that catches
    // them mid-reflection would kill the in-flight reflection.
    if (c.name.startsWith("desk-sandbox-reflect-")) continue;
    const workspaceId = c.name.slice("desk-sandbox-".length);
    if (recentlyActiveWorkspaceIds.has(workspaceId)) continue;
    // Coordinate with an in-flight grow on the same container: if
    // someone is mid-`docker update`, don't yank the container out
    // from under them. The grow lock is keyed by container name.
    if (growthInFlight.has(c.name)) continue;
    // Skip just-created containers. The sweep's DB query and a fire's
    // `createOrReuse` aren't strictly ordered, so a fire that started
    // moments ago can have produced a container without yet having
    // bumped any message row — meaning the workspace looks idle to the
    // sweep. Inspecting Created here is one extra round-trip per
    // candidate, but candidates are rare (idle workspaces only).
    try {
      const info = await engine.inspect(c.name);
      if (info?.createdAt) {
        const age = now - new Date(info.createdAt).getTime();
        if (Number.isFinite(age) && age < minAgeMs) continue;
      }
    } catch {
      // Inspect failed — treat as a transient and skip this round.
      continue;
    }
    try {
      await engine.remove(c.name, true);
      removed.push(c.name);
      console.info(`reaped idle sandbox ${c.name}`);
    } catch (err) {
      console.warn(`failed to reap ${c.name}:`, (err as Error).message);
    }
  }
  return removed;
}

/**
 * Soft idle tier: kill the `opencode serve` daemon inside sandbox
 * containers whose workspace has been quiet for `minAgeMs`, but leave
 * the container itself running. Saves ~400 MB of warm-daemon RSS per
 * sandbox without paying the full container cold-start on the next
 * message — the next `ensureOpencodeServer` re-spawns the daemon in
 * ~2-5 s against a still-warm container.
 *
 * Same `recentlyActiveWorkspaceIds` shape as `reapIdleSandboxes` so
 * the scheduler can reuse the existing active-workspace query.
 * Default 10 min — quiet enough to avoid killing daemons between
 * back-to-back chats but tight enough that long-idle workspaces
 * release the daemon's memory promptly.
 *
 * Returns the names of containers whose daemon was killed.
 */
export async function softReapIdleDaemons(
  recentlyActiveWorkspaceIds: ReadonlySet<string>,
  minAgeMs: number = 10 * 60 * 1000,
): Promise<string[]> {
  const killed: string[] = [];
  let engine: Engine;
  try {
    engine = await detectEngine();
  } catch {
    return killed;
  }
  let containers: Array<{ id: string; name: string }>;
  try {
    containers = await engine.list({ namePrefix: "desk-sandbox-", all: false });
  } catch {
    return killed;
  }
  const { killAnyOpencodeServeInContainer, invalidateOpencodeServerCache } = await import(
    "./opencodeServer.js"
  );
  const now = Date.now();
  for (const c of containers) {
    if (c.name.startsWith("desk-sandbox-reflect-")) continue;
    const workspaceId = c.name.slice("desk-sandbox-".length);
    if (recentlyActiveWorkspaceIds.has(workspaceId)) continue;
    if (growthInFlight.has(c.name)) continue;
    // Don't touch a brand-new container whose first message hasn't
    // bumped any DB row yet — same race window as the hard reap.
    try {
      const info = await engine.inspect(c.name);
      if (!info) continue;
      if (info.createdAt) {
        const age = now - new Date(info.createdAt).getTime();
        if (Number.isFinite(age) && age < minAgeMs) continue;
      }
      await killAnyOpencodeServeInContainer(engine, info.id);
      invalidateOpencodeServerCache(info.id);
      killed.push(c.name);
    } catch (err) {
      console.warn(`soft-reap failed for ${c.name}:`, (err as Error).message);
    }
  }
  return killed;
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

/**
 * Kill `opencode serve` daemons left running in workspace sandboxes by a
 * prior desk-server. Called once at startup, before `recoverOrphanedRuns`
 * requeues the rows that owned those processes.
 *
 * Why this matters: when a desk-server dies (tsx-watch reload, hard
 * crash), the in-container opencode daemon survives because nothing
 * inside the container knows the host process is gone. Its open SQLite
 * file (`~/.local/share/opencode/opencode.db`) is exclusive — the next
 * desk-server's first `opencode serve` spawn would fail to open it
 * (`SQLITE_BUSY`) and the chat would error out. Killing the orphaned
 * daemon ensures the new server starts fresh.
 *
 * Per-workspace, best-effort. Engine errors degrade to "didn't kill" —
 * a re-fire will surface the SQLite contention if anything actually
 * leaked through.
 */
export async function killOpencodeDaemonsForOrphans(
  workspaceIds: ReadonlyArray<string>,
  engineOverride?: Engine,
): Promise<{ workspaceId: string; killed: boolean }[]> {
  const results: { workspaceId: string; killed: boolean }[] = [];
  if (workspaceIds.length === 0) return results;
  let engine: Engine;
  if (engineOverride) {
    engine = engineOverride;
  } else {
    try {
      engine = await detectEngine();
    } catch {
      return workspaceIds.map((workspaceId) => ({ workspaceId, killed: false }));
    }
  }
  const { stopOpencodeServer } = await import("./opencodeServer.js");
  const perWorkspace = workspaceIds.map((workspaceId) =>
    (async () => {
      const containerName = `desk-sandbox-${workspaceId}`;
      try {
        const info = await engine.inspect(containerName);
        if (!info) return { workspaceId, killed: false };
        await stopOpencodeServer(engine, info.id);
        return { workspaceId, killed: true };
      } catch {
        return { workspaceId, killed: false };
      }
    })(),
  );
  for (const r of await Promise.all(perWorkspace)) results.push(r);
  return results;
}
