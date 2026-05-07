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
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ENGINE_COMMAND_TIMEOUT_MS = parseInt(
  process.env.DESK_CONTAINER_ENGINE_TIMEOUT_MS ?? "10000",
  10,
);

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
}

export interface ExecSpec {
  containerId: string;
  cmd: string[];
  user?: string;
  env?: string[];
}

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
  remove(nameOrId: string, force?: boolean): Promise<void>;
  list(opts: { namePrefix?: string; all?: boolean }): Promise<Array<{ id: string; name: string }>>;
  /**
   * Long-lived exec. Stdout/stderr arrive demuxed by the CLI itself
   * (when neither `-t` nor `-T` is in play, both binaries hand us
   * separate FDs already).
   */
  exec(spec: ExecSpec): Promise<ExecHandle>;
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

  private async run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync(this.name, args, {
      env: engineEnv(this.name),
      maxBuffer: 8 * 1024 * 1024,
      timeout: ENGINE_COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return { stdout, stderr };
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
    return {
      id: raw.Id,
      imageId,
      user: raw.Config?.User ?? "",
      labels: raw.Config?.Labels ?? {},
      binds,
      running: raw.State?.Running ?? false,
    };
  }

  async create(spec: RunSpec): Promise<string> {
    const args: string[] = ["run", "-d", "--name", spec.name];
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
    args.push(spec.image);
    // The image's CMD is what we want (sandbox image runs `sleep infinity`),
    // so don't append anything after it.
    try {
      const { stdout } = await this.run(args);
      return stdout.trim();
    } catch (err) {
      const stderr = ((err as { stderr?: string }).stderr ?? "").toLowerCase();
      if (stderr.includes("already in use") || stderr.includes("conflict")) {
        const e = new Error(`container name ${spec.name} already in use`) as EngineConflictError;
        e.conflict = true;
        throw e;
      }
      throw err;
    }
  }

  async start(nameOrId: string): Promise<void> {
    await this.run(["start", nameOrId]);
  }

  async stop(nameOrId: string, graceSeconds = 10): Promise<void> {
    try {
      await this.run(["stop", "-t", String(graceSeconds), nameOrId]);
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

  async remove(nameOrId: string, force = true): Promise<void> {
    try {
      const args = ["rm"];
      if (force) args.push("-f");
      args.push(nameOrId);
      await this.run(args);
    } catch (err) {
      const stderr = ((err as { stderr?: string }).stderr ?? "").toLowerCase();
      if (stderr.includes("no such")) return;
      throw err;
    }
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
    // stdin (opencode, jq -s, etc.) block forever waiting for EOF that
    // never comes (host stdin is /dev/null but the daemon doesn't
    // forward EOF on its own). Closing stdin via the absence of `-i`
    // makes the in-container process see EOF immediately and proceed.
    const args = ["exec"];
    if (spec.user) args.push("--user", spec.user);
    for (const e of spec.env ?? []) args.push("--env", e);
    args.push(spec.containerId, ...spec.cmd);

    const child: ChildProcess = spawn(this.name, args, {
      env: engineEnv(this.name),
      stdio: ["ignore", "pipe", "pipe"],
    });

    return wrapExecChild(child);
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
    // final stdout/stderr chunk from fast OpenCode runs.
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

/** Subset of the `docker inspect` / `nerdctl inspect` JSON we care about. */
interface ContainerInspect {
  Id: string;
  Image: string;
  Config?: { User?: string; Labels?: Record<string, string> };
  HostConfig?: { Binds?: string[] };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; Mode?: string }>;
  State?: { Running?: boolean };
}

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
  throw new Error(
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
