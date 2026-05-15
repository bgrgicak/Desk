/**
 * One `opencode serve` per sandbox container.
 *
 * Responsibilities:
 *   - Start `opencode serve` inside the container the first time anyone
 *     wants to talk to it; cache the host-side URL + auth password.
 *   - Multiplex subsequent requests onto that same daemon (per-container
 *     mutex so two `ensureOpencodeServer` calls don't race-start two
 *     daemons).
 *   - Stop / restart on demand (provider-key rotation, MCP config flip).
 *   - Detect crashes: callers that hit `ECONNREFUSED` invalidate this
 *     module's cache and the next request re-starts the daemon.
 *
 * Why host-driven (no in-container supervisor): opencode-serve's lifetime
 * is bounded by the container's. If the container goes away, so does the
 * daemon — there's no value in a supervisor inside it that watches a
 * process it can't outlive. Crash recovery is one host-side restart away.
 */

import * as crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Engine } from "./engine.js";

/** Container-internal port the daemon binds to. Published to host at an auto-assigned port via `-p`. */
export const OPENCODE_SERVE_CONTAINER_PORT = 9105;

/**
 * In-container absolute path to the bundled opencode binary. The
 * `opencode` shim on PATH is a Node wrapper that just spawns this
 * Bun bundle and waits for it — running both wastes ~30-50 MB of Node
 * runtime per sandbox. Spawning the bundle directly drops that
 * overhead without changing the daemon's behavior.
 */
export const OPENCODE_BIN_IN_CONTAINER =
  "/usr/local/lib/node_modules/opencode-ai/bin/.opencode";

const READY_POLL_INTERVAL_MS = 100;
const DEFAULT_READY_TIMEOUT_MS = 15_000;

export interface OpencodeServerInstance {
  containerId: string;
  /** `http://127.0.0.1:NNN` — ready to `fetch()`. */
  url: string;
  /** Bearer-style password the daemon will accept (set as `Authorization: Bearer <pw>`). Random per spawn. */
  password: string;
  /** Wall-clock time of the spawn, for "did the server restart under us?" checks. */
  startedAt: number;
  /**
   * Environment digest used at spawn time. When a caller wants to start a
   * run with different provider keys / extra env, the driver compares this
   * digest to the desired env and restarts the server if they diverge.
   */
  envDigest: string;
}

export interface StartOpencodeServerOpts {
  containerId: string;
  /** Workspace dir inside the container — opencode opens sessions relative to its cwd. */
  cwd: string;
  /** `<uid>:<gid>` to run as. Must match how the rest of the runtime execs into the container. */
  user: string;
  /**
   * Environment forwarded into the daemon. Provider keys
   * (`OPENCODE_API_KEY`, `…_API_KEY`), the Codex/ChatGPT bridge content
   * (`OPENCODE_AUTH_CONTENT`), and any model overrides go here.
   *
   * `OPENCODE_SERVER_PASSWORD` is *not* expected here — this module
   * generates it.
   */
  env: Record<string, string>;
}

interface ServerCacheEntry {
  /** Resolves to the running instance, or rejects if start failed. */
  promise: Promise<OpencodeServerInstance>;
  /** Resolved value when start succeeded; null while still pending or failed. */
  instance: OpencodeServerInstance | null;
}

const cache = new Map<string, ServerCacheEntry>();

/**
 * Per-container mutex so concurrent `ensureOpencodeServer` calls can't
 * both decide to (re)start the daemon and race-spawn into a
 * "port already in use" failure. Resolved promises are evicted
 * synchronously in `finally`, so the lock weight is one in-flight
 * promise per active container.
 */
const startLocks = new Map<string, Promise<unknown>>();

async function withContainerLock<T>(
  containerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = startLocks.get(containerId);
  const next = (prev ?? Promise.resolve()).then(fn, fn);
  // The caller awaits `next` directly, which handles its rejection. We
  // also store a tail promise so the next caller chains after this one
  // finishes. That tail rejection has its own handler so a failed
  // `fn` (e.g. `startOpencodeServer` timing out on waitForReady) doesn't
  // surface as an unhandledRejection and kill the process.
  const tail = next.finally(() => {
    if (startLocks.get(containerId) === tail) startLocks.delete(containerId);
  });
  tail.catch(() => {});
  startLocks.set(containerId, tail);
  return next;
}

/**
 * Returns the (possibly cached) server instance for the container,
 * starting one if needed. When the desired `env` digests differently from
 * the live instance's, the server is restarted with the new env before
 * being returned — this is how provider-key rotation reaches a warm
 * daemon.
 */
export async function ensureOpencodeServer(
  engine: Engine,
  opts: StartOpencodeServerOpts,
): Promise<OpencodeServerInstance> {
  return withContainerLock(opts.containerId, async () => {
    const wantedDigest = digestEnv(opts.env);
    const existing = cache.get(opts.containerId);
    if (existing) {
      const live = await existing.promise.catch(() => null);
      if (live && live.envDigest === wantedDigest) {
        // Health-check the cached daemon. The container could have
        // been stopped/recreated outside our awareness (test teardown,
        // a `stopSandbox` call, idle-sweep) leaving us pointing at a
        // port that no longer answers. Cheap probe — ~ms when alive,
        // fails fast when not.
        if (await isInstanceAlive(live)) return live;
      }
      // Env changed, last start failed, or cached instance is dead —
      // fall through to the start path below.
      if (live) await stopOpencodeServerInternal(engine, opts.containerId, live).catch(() => {});
      cache.delete(opts.containerId);
    }

    const entry: ServerCacheEntry = {
      instance: null,
      promise: startOpencodeServer(engine, opts, wantedDigest).then(
        (instance) => {
          entry.instance = instance;
          return instance;
        },
        (err) => {
          cache.delete(opts.containerId);
          throw err;
        },
      ),
    };
    cache.set(opts.containerId, entry);
    return entry.promise;
  });
}

/**
 * Forces a fresh server. The current one (if any) is killed and discarded
 * before a new spawn. Use this when in-container state changes mean the
 * daemon must re-read it — e.g. an MCP config file flip.
 */
export async function restartOpencodeServer(
  engine: Engine,
  opts: StartOpencodeServerOpts,
): Promise<OpencodeServerInstance> {
  invalidateOpencodeServerCache(opts.containerId);
  // Also kill any stray serve process *inside* the container that we
  // might not know about (e.g. after a desk-server crash). Without this,
  // the new spawn would bind-fail on the in-container port.
  await killAnyOpencodeServeInContainer(engine, opts.containerId).catch(() => {});
  return ensureOpencodeServer(engine, opts);
}

/**
 * Drops the in-memory entry without touching the container. Callers use
 * this on `ECONNREFUSED` (the daemon already died; cached URL is useless)
 * so the next `ensureOpencodeServer` re-spawns. Returns the stale
 * instance, if any, so the caller can record metrics about the
 * restart-cause.
 */
export function invalidateOpencodeServerCache(
  containerId: string,
): OpencodeServerInstance | null {
  const entry = cache.get(containerId);
  cache.delete(containerId);
  return entry?.instance ?? null;
}

/** Test-only: drops everything. */
export function _resetOpencodeServerCacheForTest(): void {
  cache.clear();
}

/**
 * Idempotently start an Xvfb display inside the container.
 *
 * Called by the host runtime when a workspace's MCP config enables
 * playwright (i.e. browser-goal chats). Chat-goal workspaces skip this
 * entirely so the ~68 MB Xvfb framebuffer doesn't sit warm for
 * sandboxes that never open a browser.
 *
 * Safe to call repeatedly: the shell script's `pgrep` check makes the
 * second call a no-op.
 */
export async function ensureContainerXvfb(
  engine: Engine,
  containerId: string,
): Promise<void> {
  const cmd = [
    "sh", "-c",
    [
      "set -e",
      "if pgrep -x Xvfb >/dev/null 2>&1; then exit 0; fi",
      "DISPLAY=\"${DISPLAY:-:99}\"",
      "Xvfb \"$DISPLAY\" -screen 0 \"${XVFB_SCREEN:-1920x1080x24}\" -nolisten tcp >/tmp/desk-xvfb.log 2>&1 &",
      // Wait briefly for the X socket to appear so playwright/firefox
      // children don't race the display startup.
      "for _ in 1 2 3 4 5 6 7 8 9 10; do",
      "  [ -S \"/tmp/.X11-unix/X${DISPLAY#:}\" ] && exit 0",
      "  sleep 0.1",
      "done",
    ].join("\n"),
  ];
  await engine.execDetached({ containerId, cmd });
}

export async function stopOpencodeServer(
  engine: Engine,
  containerId: string,
): Promise<void> {
  const entry = cache.get(containerId);
  cache.delete(containerId);
  const instance = entry?.instance ?? (await entry?.promise.catch(() => null));
  if (instance) {
    await stopOpencodeServerInternal(engine, containerId, instance);
  } else {
    // No cached instance — best-effort kill of any stray serve process.
    await killAnyOpencodeServeInContainer(engine, containerId).catch(() => {});
  }
}

async function startOpencodeServer(
  engine: Engine,
  opts: StartOpencodeServerOpts,
  envDigest: string,
): Promise<OpencodeServerInstance> {
  // The container must be running and have a `-p 127.0.0.1::9105`
  // mapping. We don't validate the latter here — `engine.port()` will
  // return null if not, and we surface a clear error then.
  const info = await engine.inspect(opts.containerId);
  if (!info) throw new Error(`opencode-serve: container ${opts.containerId} not found`);
  if (!info.running) throw new Error(`opencode-serve: container ${opts.containerId} is not running`);

  // Before starting a new daemon, kill any stragglers in the container
  // bound to the same in-container port. This handles desk-server crashes
  // where the prior daemon is still listening but our cache is empty.
  await killAnyOpencodeServeInContainer(engine, opts.containerId).catch(() => {});

  const password = crypto.randomBytes(32).toString("hex");

  // Daemonize via `nohup … &` so the process detaches from the engine
  // exec session and survives the engine CLI's return. `execDetached`
  // gives us a clean handoff at the CLI level, but the in-container
  // shell still needs to do its half. We redirect stdio so the process
  // doesn't try to write to a closed engine pipe.
  const cmd = [
    "sh", "-c",
    [
      "set -e",
      // Make sure the workspace exists; `opencode serve` writes its db
      // under HOME, not cwd, so this is just for "fromDirectory" project id.
      `mkdir -p ${shSingle(opts.cwd)}`,
      `cd ${shSingle(opts.cwd)}`,
      // `--port 9105` pins the in-container side; the engine's -p mapping
      // takes care of the host side. `--hostname 0.0.0.0` binds the
      // daemon to all interfaces *inside the container* — required
      // because Docker's userland proxy forwards from the host's
      // 127.0.0.1:HOSTPORT to the container's EXTERNAL interface, not
      // loopback. A daemon bound to 127.0.0.1 inside is unreachable from
      // the host port-forward. Network safety lives at the engine -p
      // layer: the host side is bound to 127.0.0.1, so nothing outside
      // the host machine can reach this port. Inside the container,
      // OPENCODE_SERVER_PASSWORD gates every request.
      //
      // We spawn the Bun bundle directly (`.opencode`) instead of the
      // `opencode` shim — the shim is a Node wrapper that forks the
      // bundle and waits for it. Skipping it saves the Node-runtime
      // RSS that would otherwise sit idle for the daemon's lifetime.
      `nohup ${OPENCODE_BIN_IN_CONTAINER} serve --hostname 0.0.0.0 --port ${OPENCODE_SERVE_CONTAINER_PORT} \
        >/tmp/opencode-serve.log 2>&1 &`,
      "echo $! > /tmp/opencode-serve.pid",
    ].join("\n"),
  ];

  const env: string[] = [
    `OPENCODE_SERVER_PASSWORD=${password}`,
    ...Object.entries(opts.env).map(([k, v]) => `${k}=${v}`),
  ];

  await engine.execDetached({
    containerId: opts.containerId,
    user: opts.user,
    cmd,
    env,
    cwd: opts.cwd,
  });

  // Look up the host-side port. The mapping is wired up at container
  // create time, so `engine.port` should answer immediately. We do a few
  // retries to cover container startup race in case the runtime hasn't
  // refreshed `NetworkSettings.Ports` yet.
  const binding = await pollPortBinding(engine, opts.containerId);
  if (!binding) {
    await killAnyOpencodeServeInContainer(engine, opts.containerId).catch(() => {});
    throw new Error(
      `opencode-serve: no host-side binding for container port ${OPENCODE_SERVE_CONTAINER_PORT} ` +
        `(was the sandbox created with -p ${OPENCODE_SERVE_CONTAINER_PORT} published?)`,
    );
  }
  const url = `http://${binding.hostIp}:${binding.hostPort}`;

  // Wait until the daemon responds.
  await waitForReady(url, password, DEFAULT_READY_TIMEOUT_MS);

  // opencode-serve reads `OPENCODE_AUTH_CONTENT` from its env but does
  // not auto-consume it as registered provider auth — providers are only
  // discoverable to the daemon after explicit `PUT /auth/:providerID`.
  // The Codex/ChatGPT bridge stuffs a blob like
  // `{"openai":{"type":"oauth", ...}}` into that env var, so we forward
  // each entry into the daemon's auth store here. Without this, the
  // first `POST /session/.../message` referencing that provider's model
  // fails with `ProviderModelNotFoundError`.
  if (opts.env.OPENCODE_AUTH_CONTENT) {
    await registerAuthBlobs(url, password, opts.env.OPENCODE_AUTH_CONTENT).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(
        `opencode-serve: failed to register OPENCODE_AUTH_CONTENT for ${opts.containerId}:`,
        (err as Error)?.message ?? err,
      );
    });
  }

  return {
    containerId: opts.containerId,
    url,
    password,
    startedAt: Date.now(),
    envDigest,
  };
}

/**
 * Forward `OPENCODE_AUTH_CONTENT` entries into the freshly-started
 * daemon's auth store via `PUT /auth/:providerID`. The blob shape is
 * `{<providerID>: <auth-record>}` where each auth-record has a `type`
 * field of `oauth`, `api`, or `wellknown`. Anything else is skipped
 * defensively — opencode would reject it anyway.
 */
async function registerAuthBlobs(
  url: string,
  password: string,
  rawBlob: string,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBlob);
  } catch (err) {
    throw new Error(`OPENCODE_AUTH_CONTENT is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("OPENCODE_AUTH_CONTENT does not decode to an object");
  }
  const credentials = Buffer.from(`opencode:${password}`).toString("base64");
  for (const [providerID, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { type?: unknown };
    if (e.type !== "oauth" && e.type !== "api" && e.type !== "wellknown") continue;
    const r = await fetch(`${url}/auth/${encodeURIComponent(providerID)}`, {
      method: "PUT",
      headers: {
        Authorization: `Basic ${credentials}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(entry),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      // eslint-disable-next-line no-console
      console.warn(
        `opencode-serve: PUT /auth/${providerID} returned ${r.status}: ${body.slice(0, 200)}`,
      );
    }
  }
}

async function isInstanceAlive(instance: OpencodeServerInstance): Promise<boolean> {
  const credentials = Buffer.from(`opencode:${instance.password}`).toString("base64");
  try {
    const r = await fetch(`${instance.url}/app`, {
      headers: { Authorization: `Basic ${credentials}` },
      signal: AbortSignal.timeout(1500),
    });
    // 200 = alive; 401 = alive but wrong creds (shouldn't happen since
    // we generated them, but treat as "process is up"); anything else
    // = degraded, restart.
    return r.ok || r.status === 401;
  } catch {
    return false;
  }
}

async function pollPortBinding(
  engine: Engine,
  containerId: string,
): Promise<{ hostIp: string; hostPort: number } | null> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const b = await engine.port(containerId, OPENCODE_SERVE_CONTAINER_PORT, "tcp");
    if (b) return b;
    await delay(50);
  }
  return null;
}

async function waitForReady(
  url: string,
  password: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  const credentials = Buffer.from(`opencode:${password}`).toString("base64");
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/app`, {
        headers: { Authorization: `Basic ${credentials}` },
      });
      if (r.ok || r.status === 401) {
        // 200 means we're up. 401 means we're up but credentials were
        // wrong — shouldn't happen with our own password, but it still
        // proves the HTTP handler is alive. Either way, ready.
        return;
      }
      lastErr = new Error(`status ${r.status}`);
    } catch (err) {
      lastErr = err;
    }
    await delay(READY_POLL_INTERVAL_MS);
  }
  throw new Error(
    `opencode-serve at ${url} did not become ready within ${timeoutMs}ms: ${
      (lastErr as Error)?.message ?? String(lastErr)
    }`,
  );
}

async function stopOpencodeServerInternal(
  engine: Engine,
  containerId: string,
  _instance: OpencodeServerInstance,
): Promise<void> {
  await killAnyOpencodeServeInContainer(engine, containerId);
}

/**
 * Best-effort kill of every `opencode serve` process inside the
 * container. Uses pid-file when available (faster, more targeted),
 * falls back to `pkill` matching on the command line. Idempotent.
 *
 * Matches both the bundled `.opencode serve` (current path) and the
 * legacy `opencode serve` wrapper (older sandbox images), so this
 * keeps working across upgrades.
 */
export async function killAnyOpencodeServeInContainer(
  engine: Engine,
  containerId: string,
): Promise<void> {
  // Pidfile path mirrors what `startOpencodeServer` writes. We SIGTERM
  // first, wait briefly for graceful exit, then SIGKILL any leftover so
  // the next spawn doesn't race for in-container port 9105 with a
  // dying old process. Without the wait, the new daemon's bind() can
  // race the old daemon's still-held socket and silently fail to start,
  // surfacing later as "did not become ready within 15s: fetch failed".
  const h = await engine.exec({
    containerId,
    cmd: [
      "sh", "-c",
      [
        "pid=$(cat /tmp/opencode-serve.pid 2>/dev/null || true)",
        "case \"$pid\" in ''|*[!0-9]*) ;; *) kill -TERM \"$pid\" 2>/dev/null || true ;; esac",
        // Belt-and-braces: kill anything that looks like opencode serve
        // even if the pidfile is stale or missing. Match on argv so we
        // never hit `opencode run` invocations.
        "pkill -TERM -f '\\.opencode serve' 2>/dev/null || true",
        "pkill -TERM -f 'opencode serve' 2>/dev/null || true",
        // Wait up to ~2 s for graceful exit before falling back to SIGKILL.
        "for _ in 1 2 3 4 5 6 7 8 9 10; do",
        "  pgrep -f '\\.opencode serve' >/dev/null 2>&1 || pgrep -f 'opencode serve' >/dev/null 2>&1 || break",
        "  sleep 0.2",
        "done",
        "pkill -KILL -f '\\.opencode serve' 2>/dev/null || true",
        "pkill -KILL -f 'opencode serve' 2>/dev/null || true",
        "rm -f /tmp/opencode-serve.pid 2>/dev/null || true",
        "exit 0",
      ].join("\n"),
    ],
  });
  await h.wait();
}

function shSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Stable, order-independent digest of an env map. Used to compare "what
 * the daemon was started with" against "what we need now" — when they
 * diverge, we restart. Hashing keeps the cache key bounded vs. holding
 * the full env in memory.
 */
function digestEnv(env: Record<string, string>): string {
  const sorted = Object.keys(env).sort().map((k) => `${k}=${env[k]}`).join("\n");
  return crypto.createHash("sha256").update(sorted).digest("hex");
}

export const _digestEnvForTest = digestEnv;

/** Test-only re-export. */
export const _registerAuthBlobsForTest = registerAuthBlobs;
