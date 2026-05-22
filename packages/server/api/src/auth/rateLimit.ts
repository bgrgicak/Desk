import type { IncomingMessage } from "node:http";

/**
 * Sliding-window in-memory rate limiter shared by the high-risk auth /
 * vault endpoints. We don't depend on Redis or anything cross-process —
 * Roomy is single-node by design, so the in-memory map is enough.
 *
 * Each named bucket holds an independent set of keys and configuration.
 * Limits reset implicitly when the process restarts, which is the
 * documented behaviour: an attacker who can already crash roomy-server
 * has bigger problems than a bypassable rate limit, and operators who
 * use this expect the simple semantics.
 *
 * Memory safety: a periodic sweep evicts keys whose newest stamp is
 * older than the bucket's window. Without it, an attacker spraying
 * random IPs / users could grow the Map without bound. The sweep runs
 * on a `setInterval` (unref'd) that's started at module load and is
 * cheap — it iterates buckets, filters stamps, and deletes empty keys.
 */
export interface RateLimitConfig {
  /** Window length in ms. */
  windowMs: number;
  /** Max events permitted per key within the window. */
  max: number;
}

interface BucketState {
  config: RateLimitConfig;
  hits: Map<string, number[]>;
}

const buckets = new Map<string, BucketState>();

export function defineRateLimit(name: string, config: RateLimitConfig): void {
  buckets.set(name, { config, hits: new Map() });
}

/**
 * Returns a `RateLimitDecision` summarising whether the request fits in
 * the bucket's current window. If `allowed` is false, `retryAfterMs`
 * carries the time until the oldest in-window hit expires — useful for
 * `Retry-After` headers. Calling code is responsible for translating
 * that into the HTTP response.
 */
export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export function consumeRateLimit(name: string, key: string, now: number = Date.now()): RateLimitDecision {
  // Operator escape hatch: tests and one-off scripts that hammer the
  // server with logins (e2e harness in particular) can disable the
  // limiter via ROOMY_RATE_LIMIT_DISABLED=1. Production never sets this.
  // Read at call time, not at module load, so flipping the env between
  // spawn and request still works in fixtures.
  if (process.env.ROOMY_RATE_LIMIT_DISABLED === "1") {
    return { allowed: true, retryAfterMs: 0 };
  }
  const bucket = buckets.get(name);
  if (!bucket) {
    throw new Error(`Unknown rate-limit bucket: ${name}`);
  }
  const windowStart = now - bucket.config.windowMs;
  const stamps = (bucket.hits.get(key) ?? []).filter((t) => t > windowStart);
  if (stamps.length >= bucket.config.max) {
    bucket.hits.set(key, stamps);
    // retryAfter = how long until the *oldest* in-window hit expires
    const retryAfterMs = stamps[0] + bucket.config.windowMs - now;
    return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
  }
  stamps.push(now);
  bucket.hits.set(key, stamps);
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Sweep evicts keys whose newest stamp is older than the bucket's
 * window. Bounds Map growth — without this an attacker spraying random
 * keys (e.g. spoofed X-Forwarded-For when ROOMY_TRUST_PROXY=1) could
 * grow the limiter state without bound.
 *
 * Exported so tests can run it deterministically without waiting for
 * the interval.
 */
export function sweepRateLimitState(now: number = Date.now()): void {
  for (const bucket of buckets.values()) {
    const cutoff = now - bucket.config.windowMs;
    for (const [key, stamps] of bucket.hits) {
      // The newest stamp is the last element (stamps are appended in
      // chronological order). If even that is past the cutoff every
      // stamp is stale; drop the whole key.
      if (stamps.length === 0 || stamps[stamps.length - 1] <= cutoff) {
        bucket.hits.delete(key);
      } else if (stamps[0] <= cutoff) {
        // Trim the leading stale stamps but keep the key.
        bucket.hits.set(key, stamps.filter((t) => t > cutoff));
      }
    }
  }
}

const SWEEP_INTERVAL_MS = 60_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Starts the periodic sweep timer if not already running. Called once
 * at module load; idempotent. Tests can call stop/start to take control. */
export function startRateLimitSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweepRateLimitState(), SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

/** Stops the periodic sweeper. For tests + graceful shutdown. */
export function stopRateLimitSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Test helper. Drops the in-memory state for one or every bucket. */
export function clearRateLimits(name?: string): void {
  if (name) {
    buckets.get(name)?.hits.clear();
    return;
  }
  for (const bucket of buckets.values()) bucket.hits.clear();
}

/**
 * Returns the client IP used as the per-IP key in the limiter buckets.
 *
 * X-Forwarded-For is honoured *only* when ROOMY_TRUST_PROXY=1 is set.
 * Without it, an attacker who can reach the API directly (or who can
 * tunnel into a loopback port through a misconfigured Docker
 * publication) could trivially bypass the per-IP cap by sending a
 * fresh fake XFF on every request. Operators who deploy roomy-server
 * behind nginx/caddy/Vite-preview set the env var; the default loopback
 * configuration uses req.socket.remoteAddress and ignores XFF entirely.
 *
 * When ROOMY_TRUST_PROXY=1, the first segment of XFF is used (RFC 7239:
 * "client IP" comes first; the rest is the proxy chain). Roomy doesn't
 * support a configurable hop count — operators with multi-hop chains
 * need to terminate XFF at the outermost trusted proxy.
 *
 * Empty string is returned as a sentinel when neither source produces
 * an address; callers' rate-limit decision then treats every such
 * caller as one shared bucket entry (intentional — never bypass the
 * limit on missing IP).
 */
export function getClientIp(req: IncomingMessage): string {
  if (process.env.ROOMY_TRUST_PROXY === "1") {
    const xff = req.headers["x-forwarded-for"];
    const xffStr = Array.isArray(xff) ? xff[0] : xff;
    if (xffStr) {
      const first = xffStr.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress ?? "";
}

// ── Default buckets used by auth + vault routes ──────────────────────

defineRateLimit("auth.login", { windowMs: 60_000, max: 10 });        // 10/min/IP
defineRateLimit("auth.signup", { windowMs: 60_000, max: 5 });        // 5/min/IP — abuse cap when ROOMY_ENABLE_SIGNUP is on
defineRateLimit("auth.autoLogin", { windowMs: 60_000, max: 10 });    // 10/min/IP — auto-login when ROOMY_AUTO_LOGIN is on
defineRateLimit("vault.unlock.ip", { windowMs: 60_000, max: 10 });   // 10/min/IP
defineRateLimit("vault.unlock.user", { windowMs: 300_000, max: 20 }); // 20/5min/user
defineRateLimit("me.password", { windowMs: 300_000, max: 10 });      // 10/5min/user

startRateLimitSweeper();
