import type { IncomingMessage } from "node:http";

/**
 * Sliding-window in-memory rate limiter shared by the high-risk auth /
 * vault endpoints. We don't depend on Redis or anything cross-process —
 * Desk is single-node by design, so the in-memory map is enough.
 *
 * Each named bucket holds an independent set of keys and configuration.
 * Limits reset implicitly when the process restarts, which is the
 * documented behaviour: an attacker who can already crash desk-server
 * has bigger problems than a bypassable rate limit, and operators who
 * use this expect the simple semantics.
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

/** Test helper. Drops the in-memory state for one or every bucket. */
export function clearRateLimits(name?: string): void {
  if (name) {
    buckets.get(name)?.hits.clear();
    return;
  }
  for (const bucket of buckets.values()) bucket.hits.clear();
}

/**
 * Extracts a client IP suitable for keying a per-IP rate limit. Trusts
 * `X-Forwarded-For` because Desk typically sits behind the user's own
 * reverse proxy (caddy / nginx / Vite dev proxy / Electron's localhost
 * loopback). When no XFF is present, the socket's remote address is
 * returned. Empty string is returned as a sentinel — callers can opt
 * to skip rate-limiting or treat it as a single shared key.
 */
export function getClientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const xffStr = Array.isArray(xff) ? xff[0] : xff;
  if (xffStr) {
    const first = xffStr.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? "";
}

// ── Default buckets used by auth + vault routes ──────────────────────

defineRateLimit("auth.login", { windowMs: 60_000, max: 10 });        // 10/min/IP
defineRateLimit("vault.unlock.ip", { windowMs: 60_000, max: 10 });   // 10/min/IP
defineRateLimit("vault.unlock.user", { windowMs: 300_000, max: 20 }); // 20/5min/user
defineRateLimit("me.password", { windowMs: 300_000, max: 10 });      // 10/5min/user
