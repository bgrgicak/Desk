/**
 * Container-runtime engine — abstracts dockerd vs containerd-via-nerdctl
 * behind one interface.
 *
 * Why an abstraction (and why CLI-only):
 *   - Two rootless container runtimes can't coexist on a single Linux user
 *     (rootlesskit owns one user namespace per uid). So a host that already
 *     runs `containerd-rootless` (e.g. nerdctl, Lima, k3s-rootless) cannot
 *     also start `dockerd-rootless`. Forcing docker as the only option
 *     turns those hosts into "Desk doesn't work here".
 *   - `docker` and `nerdctl` CLIs accept nearly identical flags for the
 *     operations we use (`run`, `exec`, `inspect`, `ps`, `image inspect`,
 *     `pull`, `top`, `stop`, `rm`, `info`). Wrapping them with one shared
 *     subprocess shim is much smaller than maintaining two API clients.
 *
 * Trade-off: one fork+exec per operation instead of a long-lived dockerode
 * socket connection. Per agent turn we do ~1 long-lived `exec` plus a
 * handful of inspects — subprocess overhead is negligible vs the LLM call.
 *
 * Detection order (`detectEngine()`):
 *   1. `DESK_CONTAINER_ENGINE=docker|nerdctl` env override
 *   2. `docker info` returns 0 → docker
 *   3. `nerdctl info` (with `XDG_RUNTIME_DIR` populated) returns 0 → nerdctl
 *   4. throw with a message naming both binaries
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { DeskError } from "@agent-desk/shared";

const execFileAsync = promisify(execFile);
const ENGINE_COMMAND_TIMEOUT_MS = parseInt(
  process.env.DESK_CONTAINER_ENGINE_TIMEOUT_MS ?? "10000",
  10,
);
const REMOVE_IN_PROGRESS_POLL_MS = 100;
/**
 * RootlessKit / userland port-forwarder retries. Measured: the prior
 * binding clears in 50-300 ms on a quiet host, occasionally up to ~1.5 s
 * when several containers were torn down in quick succession. Three
 * attempts at 200 / 600 / 1500 ms cover the long tail without delaying
 * a non-rootless engine where the first attempt always wins.
 */
const PORT_BIND_RETRY_ATTEMPTS = 3;
const PORT_BIND_RETRY_BACKOFF_MS = [200, 600, 1500];

function isPortPublishConflict(stderrLower: string): boolean {
  // Two surface forms we've actually observed:
  //   - "rootlesskit portmanager.addport(): listen tcp4 127.0.0.1:NNNN: bind: address already in use"
  //   - "failed to set up container networking: ... bind: address already in use"
  // The combination of "bind" + "address already in use" is specific
  // enough that name conflicts (which read "container name … is already
  // in use by container …") don't false-match.
  return stderrLower.includes("bind: address already in use") ||
    (stderrLower.includes("rootlesskit") && stderrLower.includes("already in use")) ||
    (stderrLower.includes("port is already allocated"));
}

export type EngineName = "docker" | "nerdctl";

export interface BindMount {
  /** Host path. */
  source: string;
  /** Container path. */
  target: string;
  /** Read-write or read-only. */
  mode: "rw" | "ro";
}

export interface RunSpec {
  name: string;
  image: string;
  /** `<uid>:<gid>` to run as. */
  user?: string;
  /** Pre-formatted `KEY=VALUE` strings. */
  env: string[];
  labels?: Record<string, string>;
  capDrop?: string[];
  /** Defaults to `bridge`. */
  network?: string;
  /** Each entry passed verbatim as `--add-host`. */
  extraHosts?: string[];
  pidsLimit?: number;
  memoryBytes?: number;
  /** mount-target → options string (empty for default). */
  tmpfs?: Record<string, string>;
  binds: BindMount[];
  /**
   * When true, pass `--init` to the engine CLI so PID 1 inside the
   * container is a minimal reaper (Docker's bundled tini). Required for
   * any image whose `CMD` is a non-reaping process (e.g. `sleep infinity`)
   * that would otherwise leave `<defunct>` zombies whenever a grandchild
   * is reparented to PID 1.
   */
  init?: boolean;
  /**
   * Port publishes (`-p`). One entry per published container port. We
   * always pin `hostIp` and leave `hostPort` undefined when we want the
   * engine to auto-assign — the assigned port is then read back with
   * `Engine.port()`. Auto-assignment keeps multiple sandboxes from
   * fighting over a fixed host port.
   */
  ports?: PortPublish[];
}

export interface PortPublish {
  /** Port the in-container process listens on. */
  containerPort: number;
  /** Defaults to `127.0.0.1`. We never bind to all interfaces. */
  hostIp?: string;
  /** When omitted, the engine auto-assigns a free port on `hostIp`. */
  hostPort?: number;
  /** Defaults to `tcp`. */
  protocol?: "tcp" | "udp";
}

export interface ContainerInfo {
  id: string;
  imageId: string;
  /** As reported by the engine (typically `<uid>:<gid>` or empty). */
  user: string;
  labels: Record<string, string>;
  /** Bind-mount strings in the form returned by `inspect` for parity comparisons. */
  binds: string[];
  running: boolean;
  /**
   * Current pids-cgroup limit. Reflects the value passed to `--pids-limit`
   * at create time, but also picks up any later `docker update --pids-limit`
   * — which is the auto-scale primitive we use to grow a hot sandbox in
   * place without recreating it.
   */
  pidsLimit?: number;
  /** Current memory-cgroup limit in bytes, with the same live-update semantics as `pidsLimit`. */
  memoryBytes?: number;
  /**
   * Container creation timestamp (ISO 8601). Used by the idle-sweeper to
   * skip just-created containers — otherwise a `createOrReuse` racing the
   * sweep can have its brand-new sandbox yanked out from under it.
   */
  createdAt?: string;
  /**
   * Container ports published to the host, normalized as
   * `{containerPort}/{protocol}` → `[{hostIp, hostPort}]`. Empty when the
   * container has no `-p` mappings. The shape mirrors what `docker inspect`
   * returns under `NetworkSettings.Ports`, normalized across docker/nerdctl.
   */
  publishedPorts?: Record<string, Array<{ hostIp: string; hostPort: number }>>;
}

export interface ExecSpec {
  containerId: string;
  cmd: string[];
  user?: string;
  env?: string[];
  /** Working directory inside the container (`--workdir`). */
  cwd?: string;
}

// Same shape as ExecSpec — semantic difference is the engine returns
// once the engine CLI has handed off, not when the in-container process
// exits. Kept as a type alias instead of an empty-extending interface
// so the lint rule against zero-member interfaces stays happy.
export type ExecDetachedSpec = ExecSpec;

export interface ExecHandle {
  /** Demuxed stdout. Ends when the process exits. */
  stdout: Readable;
  /** Demuxed stderr. Ends when the process exits. */
  stderr: Readable;
  /** Resolves with the in-container exit code after the process exits. */
  wait(): Promise<number>;
  /**
   * Best-effort cancel. Sends SIGTERM to the wrapper subprocess; the
   * caller is responsible for any in-container kill via top()+exec(kill).
   */
  cancel(): Promise<void>;
}

export interface EngineConflictError extends Error {
  conflict: true;
}

/**
 * Rootless Docker (via RootlessKit's userland port forwarder) sometimes
 * refuses to bind a freshly-allocated host port because the previous
 * container's `docker-proxy` hasn't released it yet. Surfaces as
 *   `error while calling RootlessKit PortManager.AddPort():
 *    listen tcp4 127.0.0.1:NNNN: bind: address already in use`
 * during `docker run` (or a subsequent `docker start`). Recoverable by
 * retrying with backoff — the proxy releases asynchronously. Engine
 * implementations throw this so callers can distinguish a port-forwarding
 * race from a real "name in use" container conflict.
 */
export class PortPublishConflictError extends Error {
  readonly engine: "docker" | "nerdctl" | "unknown";
  readonly originalStderr: string;
  constructor(engine: "docker" | "nerdctl" | "unknown", originalStderr: string) {
    super(
      `host port binding refused by ${engine} (RootlessKit / port-forwarder did not release ` +
        `the prior binding yet): ${originalStderr.trim()}`,
    );
    this.name = "PortPublishConflictError";
    this.engine = engine;
    this.originalStderr = originalStderr;
  }
}

export class ContainerRuntimeUnavailableError extends DeskError {
  constructor(message: string) {
    super("RUNTIME_UNAVAILABLE", message);
    this.name = "ContainerRuntimeUnavailableError";
  }
}

/**
 * Builds a safe error message for a failed engine command. Hides the
 * `--env KEY=VALUE` pairs (which often carry provider keys and OAuth
 * tokens) but keeps the engine name, subcommand, target id, exit code,
 * and full stderr — everything an operator needs to triage without
 * leaking the secrets that the chaos test surfaced were going through
 * into chat messages.
 *
 * Env values are replaced with `<REDACTED>`; the env *keys* stay
 * visible so the operator can still see "GITHUB_TOKEN was set" vs
 * "GITHUB_TOKEN was empty" by inspecting the redacted form's key list.
 */
export function formatEngineErrorMessage(
  engineName: string,
  args: readonly string[],
  stderr: string,
  exitCode: number | string | undefined,
): string {
  const safeArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--env" && i + 1 < args.length) {
      const pair = args[i + 1];
      const eq = pair.indexOf("=");
      const key = eq >= 0 ? pair.slice(0, eq) : pair;
      safeArgs.push("--env", `${key}=<REDACTED>`);
      i++;
      continue;
    }
    safeArgs.push(a);
  }
  const exitFrag = exitCode !== undefined ? ` (exit ${exitCode})` : "";
  const stderrTrim = stderr.trim();
  const stderrFrag = stderrTrim ? `\n${stderrTrim}` : "";
  return `${engineName} ${safeArgs.join(" ")} failed${exitFrag}${stderrFrag}`;
}

/** Caller-facing surface. Pure shell-out under the hood. */
export interface Engine {
  readonly name: EngineName;
  /**
   * Returns the container id, or null if no container with that name/id
   * exists. Throws on transport errors.
   */
  inspect(nameOrId: string): Promise<ContainerInfo | null>;
  imageId(image: string): Promise<string | null>;
  /**
   * Pulls `image`. Streams CLI stderr to `onProgress` so a long pull
   * doesn't look like a hang.
   */
  imagePull(image: string, onProgress?: (line: string) => void): Promise<void>;
  /**
   * Creates and starts the container in one call. Returns the container
   * id. If the name is already in use, throws an error with `.conflict
   * = true`.
   */
  create(spec: RunSpec): Promise<string>;
  start(nameOrId: string): Promise<void>;
  stop(nameOrId: string, graceSeconds?: number): Promise<void>;
  /**
   * Mutates cgroup limits on a *running* container — `docker update`-style.
   * Returns true if the engine accepted the update, false if it isn't
   * supported (e.g. an older nerdctl). The caller treats unsupported as
   * "stay at the current size" rather than failing the run.
   *
   * This is the auto-scale primitive: an `xs` sandbox that hits a busy
   * vite build can grow to `m` mid-run without restarting the in-flight
   * pi. We deliberately don't expose recreate as an alternative
   * because recreating mid-run kills the live tree we just promised to
   * keep alive in `cleanupRunProcessTree`.
   */
  update(nameOrId: string, opts: { pidsLimit?: number; memoryBytes?: number }): Promise<boolean>;
  remove(nameOrId: string, force?: boolean): Promise<void>;
  list(opts: { namePrefix?: string; all?: boolean }): Promise<Array<{ id: string; name: string }>>;
  /**
   * Long-lived exec. Stdout/stderr arrive demuxed by the CLI itself
   * (when neither `-t` nor `-T` is in play, both binaries hand us
   * separate FDs already).
   */
  exec(spec: ExecSpec): Promise<ExecHandle>;
  /**
   * Detached exec. Starts an in-container process and resolves once the
   * engine CLI has spawned it (typically subsecond). The process keeps
   * running inside the container after this returns; callers needing to
   * stop it should use `top()` + `exec(["kill", ...])` or recreate the
   * container.
   */
  execDetached(spec: ExecDetachedSpec): Promise<void>;
  /**
   * Looks up the host-side binding for a published container port. Returns
   * null if the container exists but the port isn't published (or the
   * runtime hasn't allocated it yet). Wraps `docker port` / `nerdctl
   * port`; the result is normalized across both.
   */
  port(
    nameOrId: string,
    containerPort: number,
    protocol?: "tcp" | "udp",
  ): Promise<{ hostIp: string; hostPort: number } | null>;
  /** PID + cmdline of every process in the container. */
  top(nameOrId: string): Promise<Array<{ pid: string; cmd: string }>>;
  isRootless(): Promise<boolean>;
}

/** Process env for the chosen binary. */
function engineEnv(name: EngineName): NodeJS.ProcessEnv {
  if (name === "nerdctl") {
    // nerdctl needs XDG_RUNTIME_DIR to find rootless containerd's socket.
    // Default to /run/user/<uid> if the parent process didn't set it.
    if (!process.env.XDG_RUNTIME_DIR) {
      const uid = (process.getuid?.() ?? 1000).toString();
      return { ...process.env, XDG_RUNTIME_DIR: `/run/user/${uid}` };
    }
  }
  return process.env;
}

class CliEngine implements Engine {
  constructor(public readonly name: EngineName) {}

  private async run(
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(this.name, args, {
        env: engineEnv(this.name),
        maxBuffer: 8 * 1024 * 1024,
        timeout: opts?.timeoutMs ?? ENGINE_COMMAND_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      return { stdout, stderr };
    } catch (err) {
      // Node's execFile reject sets `.message` to the full command line
      // including every `--env KEY=VALUE` pair we pass into `docker
      // exec`. Those env values frequently carry secrets — provider API
      // keys, the Codex/ChatGPT OAuth blob, GitHub PATs — and the
      // message gets propagated up
      // into emitLog("stderr") in driver.ts, where it ends up in a chat
      // message visible to the user (and any log shipper that reads the
      // pino stream). Rewrite the message into a safe shape that keeps
      // the operationally-useful bits (engine name, subcommand, exit
      // code, stderr tail) but scrubs the env values.
      const e = err as { message?: string; stderr?: string; code?: number | string; stdout?: string };
      const stderr = typeof e.stderr === "string" ? e.stderr : "";
      const safeMessage = formatEngineErrorMessage(this.name, args, stderr, e.code);
      const wrapped = new Error(safeMessage) as Error & {
        stderr: string;
        stdout: string;
        code: number | string | undefined;
        cause: unknown;
      };
      wrapped.stderr = stderr;
      wrapped.stdout = typeof e.stdout === "string" ? e.stdout : "";
      wrapped.code = e.code;
      wrapped.cause = err;
      throw wrapped;
    }
  }

  /** Capture-or-null: returns null if stderr matches "no such" pattern. */
  private async runOrNull(args: string[], notFoundFragments: string[]): Promise<string | null> {
    try {
      const { stdout } = await this.run(args);
      return stdout;
    } catch (err) {
      const stderr = ((err as { stderr?: string }).stderr ?? "").toLowerCase();
      if (notFoundFragments.some((f) => stderr.includes(f))) return null;
      throw err;
    }
  }

  async imageId(image: string): Promise<string | null> {
    const out = await this.runOrNull(
      ["image", "inspect", "--format", "{{.Id}}", image],
      ["no such image", "not found"],
    );
    return out ? out.trim() : null;
  }

  async imagePull(image: string, onProgress?: (line: string) => void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.name, ["pull", image], {
        env: engineEnv(this.name),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const ondata = (chunk: Buffer) => {
        if (!onProgress) return;
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
          if (line) onProgress(line);
        }
      };
      child.stdout?.on("data", ondata);
      child.stderr?.on("data", ondata);
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${this.name} pull ${image} exited ${code}`))));
    });
  }

  async inspect(nameOrId: string): Promise<ContainerInfo | null> {
    const out = await this.runOrNull(
      ["inspect", "--format", "{{json .}}", nameOrId],
      ["no such object", "no such container", "not found"],
    );
    if (!out) return null;
    let raw: ContainerInspect;
    try {
      raw = JSON.parse(out) as ContainerInspect;
    } catch (err) {
      throw new Error(`${this.name} inspect ${nameOrId}: invalid JSON (${(err as Error).message})`);
    }
    // Bind-mount source-of-truth differs by engine. Docker fills both
    // .HostConfig.Binds (string array, "src:dst:mode") and .Mounts
    // (structured). nerdctl populates only .Mounts; HostConfig.Binds
    // is null. Normalize both into the docker-style string format the
    // rest of the codebase uses for parity comparisons.
    const binds =
      raw.HostConfig?.Binds && raw.HostConfig.Binds.length > 0
        ? raw.HostConfig.Binds
        : (raw.Mounts ?? [])
            .filter((m) => m.Type === "bind" && m.Source && m.Destination)
            .map((m) => `${m.Source}:${m.Destination}:${m.Mode || "rw"}`);
    // Image-id source-of-truth differs too. Docker exposes
    // .Image = "sha256:…" (the digest). nerdctl exposes the reference
    // used at create time (e.g. "docker.io/desk/sandbox:v1"). Resolve
    // refs to digests so callers can compare against `imageId()`.
    let imageId = raw.Image;
    if (imageId && !imageId.startsWith("sha256:")) {
      const resolved = await this.imageId(imageId);
      if (resolved) imageId = resolved;
    }
    // pids/memory limits. Docker exposes the literal values that were
    // most recently set (create-time or via `docker update`). `0` and
    // negative values both mean "no limit" in the cgroup; surface
    // undefined in that case so callers don't compare against bogus
    // numbers when deciding whether to up-scale.
    const rawPids = raw.HostConfig?.PidsLimit;
    const pidsLimit = typeof rawPids === "number" && rawPids > 0 ? rawPids : undefined;
    const rawMem = raw.HostConfig?.Memory;
    const memoryBytes = typeof rawMem === "number" && rawMem > 0 ? rawMem : undefined;
    const publishedPorts = normalizePortBindings(raw);
    return {
      id: raw.Id,
      imageId,
      user: raw.Config?.User ?? "",
      labels: raw.Config?.Labels ?? {},
      binds,
      running: raw.State?.Running ?? false,
      pidsLimit,
      memoryBytes,
      createdAt: raw.Created,
      publishedPorts,
    };
  }

  async create(spec: RunSpec): Promise<string> {
    const args: string[] = ["run", "-d", "--name", spec.name];
    if (spec.init) args.push("--init");
    if (spec.user) args.push("--user", spec.user);
    for (const e of spec.env) args.push("--env", e);
    for (const [key, value] of Object.entries(spec.labels ?? {})) {
      args.push("--label", `${key}=${value}`);
    }
    for (const c of spec.capDrop ?? []) args.push("--cap-drop", c);
    args.push("--network", spec.network ?? "bridge");
    for (const h of spec.extraHosts ?? []) args.push("--add-host", h);
    if (spec.pidsLimit !== undefined) args.push("--pids-limit", String(spec.pidsLimit));
    if (spec.memoryBytes !== undefined) args.push("--memory", String(spec.memoryBytes));
    for (const [target, opts] of Object.entries(spec.tmpfs ?? {})) {
      args.push("--tmpfs", opts ? `${target}:${opts}` : target);
    }
    for (const b of spec.binds) {
      args.push("-v", `${b.source}:${b.target}:${b.mode}`);
    }
    for (const p of spec.ports ?? []) {
      args.push("-p", formatPortPublish(p));
    }
    args.push(spec.image);
    // The image's CMD is what we want (sandbox image runs `sleep infinity`),
    // so don't append anything after it.
    //
    // Two failure modes get classified here, before bubbling to callers:
    //   - Name conflict (the workspace serializer's loser, or a stale
    //     container that wasn't reaped yet): EngineConflictError.
    //   - RootlessKit / port-forwarder hasn't released the prior host port
    //     binding yet: PortPublishConflictError. The userland proxy is
    //     async; the prior container's `docker-proxy` can stay listening
    //     for hundreds of ms after the container is gone. We retry with
    //     short backoff inside `create` so callers see at most one of
    //     these per real failure rather than every transient race.
    let lastPortConflict: PortPublishConflictError | null = null;
    for (let attempt = 0; attempt < PORT_BIND_RETRY_ATTEMPTS; attempt++) {
      try {
        const { stdout } = await this.run(args);
        return stdout.trim();
      } catch (err) {
        const stderrRaw = (err as { stderr?: string }).stderr ?? "";
        const stderr = stderrRaw.toLowerCase();
        if (isPortPublishConflict(stderr)) {
          // Name was registered before `docker run` failed at the network
          // step. Without removing it, the next attempt sees "already in
          // use" and we never get past the conflict. `remove --force` is
          // idempotent on a name with no live container.
          await this.remove(spec.name, true).catch(() => {});
          lastPortConflict = new PortPublishConflictError(this.name, stderrRaw);
          if (attempt < PORT_BIND_RETRY_ATTEMPTS - 1) {
            await delay(PORT_BIND_RETRY_BACKOFF_MS[attempt]);
            continue;
          }
          throw lastPortConflict;
        }
        if (stderr.includes("already in use") || stderr.includes("conflict")) {
          const e = new Error(`container name ${spec.name} already in use`) as EngineConflictError;
          e.conflict = true;
          throw e;
        }
        throw err;
      }
    }
    // Loop exit without success — only reachable if PORT_BIND_RETRY_ATTEMPTS
    // is zero, which would be a code change. Surface the last conflict so
    // callers can route to the recovery path.
    throw lastPortConflict ?? new Error(`${this.name} run failed after retries`);
  }

  async start(nameOrId: string): Promise<void> {
    // `docker start` on a container that already failed at the network
    // step can hit the same RootlessKit port-bind race as `create`. The
    // existing `--restart=no` containers won't auto-retry; we do it here
    // so transient port conflicts during create-then-start sequences
    // self-heal at the engine layer.
    let lastPortConflict: PortPublishConflictError | null = null;
    for (let attempt = 0; attempt < PORT_BIND_RETRY_ATTEMPTS; attempt++) {
      try {
        await this.run(["start", nameOrId]);
        return;
      } catch (err) {
        const stderrRaw = (err as { stderr?: string }).stderr ?? "";
        const stderr = stderrRaw.toLowerCase();
        if (isPortPublishConflict(stderr)) {
          lastPortConflict = new PortPublishConflictError(this.name, stderrRaw);
          if (attempt < PORT_BIND_RETRY_ATTEMPTS - 1) {
            await delay(PORT_BIND_RETRY_BACKOFF_MS[attempt]);
            continue;
          }
          throw lastPortConflict;
        }
        throw err;
      }
    }
    throw lastPortConflict ?? new Error(`${this.name} start failed after retries`);
  }

  async stop(nameOrId: string, graceSeconds = 10): Promise<void> {
    try {
      await this.run(["stop", "-t", String(graceSeconds), nameOrId], {
        timeoutMs: Math.max(ENGINE_COMMAND_TIMEOUT_MS, (graceSeconds + 5) * 1000),
      });
    } catch (err) {
      // Ignore "already stopped" / "no such container" — stop is idempotent
      // from the caller's perspective.
      const stderr = ((err as { stderr?: string }).stderr ?? "").toLowerCase();
      if (
        stderr.includes("no such") ||
        stderr.includes("not running") ||
        stderr.includes("not found")
      ) {
        return;
      }
      throw err;
    }
  }

  async update(
    nameOrId: string,
    opts: { pidsLimit?: number; memoryBytes?: number },
  ): Promise<boolean> {
    const args = ["update"];
    if (opts.pidsLimit !== undefined) args.push("--pids-limit", String(opts.pidsLimit));
    if (opts.memoryBytes !== undefined) {
      args.push("--memory", String(opts.memoryBytes));
      // On cgroup v1, docker requires `--memory-swap >= --memory`; raising
      // `--memory` alone is rejected with "memory+swap limit should be >=
      // memory limit". Passing `-1` (unlimited) only works on the FIRST
      // update: the daemon silently caps swap to the prior memory value
      // rather than uncapping it, so the next grow hits the same validation
      // error again. Setting swap equal to the new memory ("no extra swap")
      // always satisfies the constraint and works identically on cgroup v2.
      args.push("--memory-swap", String(opts.memoryBytes));
    }
    if (args.length === 1) return true; // nothing to change
    args.push(nameOrId);
    try {
      await this.run(args);
      return true;
    } catch (err) {
      const stderr = ((err as { stderr?: string }).stderr ?? "").toLowerCase();
      // Older nerdctl builds don't implement `update`. Treat that as
      // "size stays where it is" rather than failing the run — we can
      // still serve the request at the old limits, the worst case is
      // hitting pids-cgroup pressure that an upgrade would have relieved.
      if (
        stderr.includes("unknown command") ||
        stderr.includes("not implemented") ||
        stderr.includes("command not found")
      ) {
        return false;
      }
      throw err;
    }
  }

  async remove(nameOrId: string, force = true): Promise<void> {
    try {
      const args = ["rm"];
      if (force) args.push("-f");
      args.push(nameOrId);
      await this.run(args);
    } catch (err) {
      const stderr = ((err as { stderr?: string }).stderr ?? "").toLowerCase();
      if (stderr.includes("no such")) return;
      if (isRemovalAlreadyInProgress(stderr)) {
        const gone = await this.waitForContainerRemoval(nameOrId);
        if (gone) return;
      }
      throw err;
    }
  }

  private async waitForContainerRemoval(nameOrId: string): Promise<boolean> {
    const deadline = Date.now() + ENGINE_COMMAND_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const out = await this.runOrNull(
        ["inspect", "--format", "{{.Id}}", nameOrId],
        ["no such object", "no such container", "not found"],
      );
      if (!out) return true;
      await delay(REMOVE_IN_PROGRESS_POLL_MS);
    }
    return false;
  }

  async list(opts: { namePrefix?: string; all?: boolean }): Promise<Array<{ id: string; name: string }>> {
    const args = ["ps", "--format", "{{.ID}}\t{{.Names}}"];
    if (opts.all) args.push("-a");
    if (opts.namePrefix) args.push("--filter", `name=${opts.namePrefix}`);
    const { stdout } = await this.run(args);
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, name] = line.split("\t");
        return { id, name };
      });
  }

  async exec(spec: ExecSpec): Promise<ExecHandle> {
    // Intentionally NO `-i`: with `-i` the in-container process sees stdin
    // as an open pipe, and well-behaved CLIs that auto-detect a piped
    // stdin (pi, jq -s, etc.) block forever waiting for EOF that
    // never comes (host stdin is /dev/null but the engine doesn't
    // forward EOF on its own). Closing stdin via the absence of `-i`
    // makes the in-container process see EOF immediately and proceed.
    const args = ["exec"];
    if (spec.user) args.push("--user", spec.user);
    if (spec.cwd) args.push("--workdir", spec.cwd);
    for (const e of spec.env ?? []) args.push("--env", e);
    args.push(spec.containerId, ...spec.cmd);

    const child: ChildProcess = spawn(this.name, args, {
      env: engineEnv(this.name),
      stdio: ["ignore", "pipe", "pipe"],
    });

    return wrapExecChild(child);
  }

  async execDetached(spec: ExecDetachedSpec): Promise<void> {
    // `-d` returns the engine CLI immediately once the in-container
    // process is spawned. Used for processes that should outlive this
    // engine call (e.g. Xvfb).
    const args = ["exec", "-d"];
    if (spec.user) args.push("--user", spec.user);
    if (spec.cwd) args.push("--workdir", spec.cwd);
    for (const e of spec.env ?? []) args.push("--env", e);
    args.push(spec.containerId, ...spec.cmd);
    await this.run(args);
  }

  async port(
    nameOrId: string,
    containerPort: number,
    protocol: "tcp" | "udp" = "tcp",
  ): Promise<{ hostIp: string; hostPort: number } | null> {
    // `docker port <id> <port>/<proto>` returns one line per binding,
    // e.g. `127.0.0.1:34571`. nerdctl's CLI is identical.
    const out = await this.runOrNull(
      ["port", nameOrId, `${containerPort}/${protocol}`],
      ["no such", "not found", "no public port", "error: no port"],
    );
    if (!out) return null;
    const line = out.split("\n").map((l) => l.trim()).find(Boolean);
    if (!line) return null;
    return parsePortMapping(line);
  }

  async top(nameOrId: string): Promise<Array<{ pid: string; cmd: string }>> {
    try {
      // -o pid,cmd works for both docker and nerdctl (passed through to ps).
      const { stdout } = await this.run(["top", nameOrId, "-o", "pid,cmd"]);
      const lines = stdout.split("\n").filter(Boolean);
      // First line is the header (PID CMD) — skip it.
      return lines.slice(1).map((line) => {
        const trimmed = line.trim();
        const sp = trimmed.indexOf(" ");
        if (sp === -1) return { pid: trimmed, cmd: "" };
        return { pid: trimmed.slice(0, sp), cmd: trimmed.slice(sp + 1).trim() };
      });
    } catch (err) {
      const stderr = ((err as { stderr?: string }).stderr ?? "").toLowerCase();
      if (stderr.includes("no such") || stderr.includes("not running")) return [];
      throw err;
    }
  }

  private _rootless?: boolean;
  async isRootless(): Promise<boolean> {
    if (this._rootless !== undefined) return this._rootless;
    try {
      const { stdout } = await this.run(["info", "--format", "{{.SecurityOptions}}"]);
      this._rootless = stdout.includes("rootless");
    } catch {
      this._rootless = false;
    }
    return this._rootless;
  }
}

function wrapExecChild(child: ChildProcess): ExecHandle {
  // Re-export stdout/stderr as PassThrough so caller can attach handlers
  // before any data arrives without racing.
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);

  const closed = new Promise<number>((resolve) => {
    let resolved = false;
    const done = (code: number | null | undefined) => {
      if (resolved) return;
      resolved = true;
      resolve(code ?? 1);
    };
    // `close`, unlike `exit`, waits until stdio is closed. The scheduler reads
    // the run log immediately after wait(), so returning on `exit` can drop the
    // final stdout/stderr chunk from fast pi runs.
    child.on("close", done);
    child.on("error", () => done(1));
  });

  return {
    stdout,
    stderr,
    wait: () => closed,
    cancel: async () => {
      if (child.exitCode === null) {
        // Killing the wrapper alone may leave the in-container process
        // running on some runtimes; caller should also issue a
        // top()+exec(["kill", ...]) for that.
        child.kill("SIGTERM");
      }
    },
  };
}

export const _wrapExecChildForTest = wrapExecChild;

export function _isRemovalAlreadyInProgressForTest(stderr: string): boolean {
  return isRemovalAlreadyInProgress(stderr.toLowerCase());
}

function isRemovalAlreadyInProgress(stderr: string): boolean {
  return stderr.includes("removal of container") && stderr.includes("already in progress");
}

/** Subset of the `docker inspect` / `nerdctl inspect` JSON we care about. */
interface ContainerInspect {
  Id: string;
  Image: string;
  Created?: string;
  Config?: { User?: string; Labels?: Record<string, string> };
  HostConfig?: {
    Binds?: string[];
    PidsLimit?: number;
    Memory?: number;
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; Mode?: string }>;
  State?: { Running?: boolean };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
}

/**
 * Formats a `PortPublish` for the `-p` flag.
 *
 * Examples:
 *   `{containerPort: 9105}` → `127.0.0.1::9105/tcp` (engine picks host port).
 *   `{containerPort: 9105, hostPort: 12345}` → `127.0.0.1:12345:9105/tcp`.
 *   `{containerPort: 9105, hostIp: "0.0.0.0"}` → `0.0.0.0::9105/tcp`.
 */
function formatPortPublish(p: PortPublish): string {
  const proto = p.protocol ?? "tcp";
  const hostIp = p.hostIp ?? "127.0.0.1";
  const hostPort = p.hostPort === undefined ? "" : String(p.hostPort);
  return `${hostIp}:${hostPort}:${p.containerPort}/${proto}`;
}

/**
 * Parses one line of `docker port` output into `{hostIp, hostPort}`. Lines
 * look like `127.0.0.1:34571` (IPv4) or `[::]:34571` (IPv6). We ignore the
 * IPv6 form — we never bind to IPv6 — to avoid feeding `[::]` into a
 * `fetch()`.
 */
function parsePortMapping(line: string): { hostIp: string; hostPort: number } | null {
  // IPv4: 127.0.0.1:34571   IPv6: [::]:34571 or [::1]:34571
  if (line.startsWith("[")) return null;
  const colon = line.lastIndexOf(":");
  if (colon <= 0) return null;
  const hostIp = line.slice(0, colon);
  const hostPort = Number(line.slice(colon + 1));
  if (!Number.isFinite(hostPort) || hostPort <= 0) return null;
  return { hostIp, hostPort };
}

/**
 * Pulls the published-ports map out of the inspect JSON. Both docker and
 * nerdctl fill in `NetworkSettings.Ports` for a *running* container with
 * the live host-side bindings; `HostConfig.PortBindings` is the
 * create-time request. The live view is what we actually want — that's
 * the source of truth for "what host port did the engine assign me?".
 * Falls back to PortBindings when NetworkSettings is empty (a container
 * inspected immediately after create, before the daemon has wired up
 * iptables, can have an empty NetworkSettings.Ports).
 */
function normalizePortBindings(
  raw: ContainerInspect,
): Record<string, Array<{ hostIp: string; hostPort: number }>> | undefined {
  const live = raw.NetworkSettings?.Ports ?? {};
  const requested = raw.HostConfig?.PortBindings ?? {};
  const keys = new Set([...Object.keys(live), ...Object.keys(requested)]);
  if (keys.size === 0) return undefined;
  const out: Record<string, Array<{ hostIp: string; hostPort: number }>> = {};
  for (const key of keys) {
    const bindings = live[key]?.length ? live[key] : requested[key];
    if (!bindings) continue;
    const normalized: Array<{ hostIp: string; hostPort: number }> = [];
    for (const b of bindings) {
      const hostIp = b?.HostIp || "127.0.0.1";
      const hostPort = Number(b?.HostPort ?? 0);
      if (!Number.isFinite(hostPort) || hostPort <= 0) continue;
      normalized.push({ hostIp, hostPort });
    }
    if (normalized.length > 0) out[key] = normalized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const _parsePortMappingForTest = parsePortMapping;
export const _formatPortPublishForTest = formatPortPublish;
export const _normalizePortBindingsForTest = (raw: unknown) =>
  normalizePortBindings(raw as ContainerInspect);

/** Cached engine selection so detection runs once per process. */
let _engine: Engine | undefined;

/** Reset the cache. Test-only. */
export function _resetEngineCache(): void {
  _engine = undefined;
}

/**
 * Pick the active engine for this host. Honors `DESK_CONTAINER_ENGINE` if
 * set; otherwise probes docker first, then nerdctl, then throws.
 */
export async function detectEngine(): Promise<Engine> {
  if (_engine) return _engine;

  const override = process.env.DESK_CONTAINER_ENGINE as EngineName | undefined;
  const order: EngineName[] = override
    ? [override]
    : ["docker", "nerdctl"];

  const errors: string[] = [];
  for (const candidate of order) {
    if (await probe(candidate)) {
      _engine = new CliEngine(candidate);
      return _engine;
    }
    errors.push(`${candidate} info failed`);
  }
  throw new ContainerRuntimeUnavailableError(
    `No container runtime available. Tried: ${errors.join(", ")}. ` +
      `Install docker or nerdctl, or set DESK_CONTAINER_ENGINE.`,
  );
}

/** True if `<binary> info` exits 0. Quick — no caching, called once. */
async function probe(binary: EngineName): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["info", "--format", "{{.ID}}"], {
      env: engineEnv(binary),
      stdio: "ignore",
      timeout: 5000,
      killSignal: "SIGKILL",
    });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(false);
    }, 5000);
    child.on("error", () => done(false));
    child.on("exit", (code) => done(code === 0));
  });
}
