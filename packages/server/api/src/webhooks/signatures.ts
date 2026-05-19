/**
 * Webhook signature verification framework.
 *
 * Inbound webhooks (GitHub push events, Drive change notifications,
 * Stripe-style providers, …) carry an HMAC signature in a header and
 * a timestamp the integration must validate. Without a shared helper
 * each integration would roll its own constant-time compare and its
 * own replay window — both are exactly the places people get it wrong.
 *
 * Threat model:
 * - Forged events: an attacker who can reach the webhook endpoint
 *   shouldn't be able to post a synthetic payload claiming to be
 *   from the upstream. Defeated by HMAC-SHA256 of the raw body
 *   against a per-provider secret + constant-time compare.
 * - Replay: an attacker who captured a valid event shouldn't be
 *   able to replay it days later. Defeated by a replay window
 *   (default 5 min) checked against an integration-supplied
 *   `timestamp` header.
 * - Cross-provider mixing: per-provider secrets so a compromised
 *   GitHub webhook secret doesn't authenticate Drive events.
 *
 * Out of scope for v1:
 * - Idempotency store (each integration handles dedupe with its own
 *   primary key — e.g. GitHub delivery IDs).
 * - Asymmetric (JWT) signatures. Land when the first JWS-using
 *   integration arrives.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifySignatureArgs {
  /** Raw request body as bytes — must NOT be re-parsed first; the
   *  signature is over the wire bytes, not the JSON-roundtripped form. */
  body: Buffer | string;
  /** Hex (e.g. "abc123..." or "sha256=abc123...") or base64 signature
   *  from the upstream header. The "sha256=" prefix is stripped if
   *  present (GitHub convention). */
  signatureHeader: string;
  /** Shared HMAC secret stored alongside the connector connection. */
  secret: string;
  /** Algorithm. Defaults to sha256 (GitHub/Stripe/most providers). */
  algorithm?: "sha256" | "sha1" | "sha512";
  /** ISO-8601 string OR unix-seconds string from a timestamp header
   *  (e.g. Stripe's `Stripe-Signature.t=`). Used for replay-window
   *  enforcement. Omit only if the upstream provider doesn't emit
   *  one — in that case set `replayWindowMs` to 0. */
  timestamp?: string;
  /** Max age, ms, for the timestamp. Default 5 min. */
  replayWindowMs?: number;
  /** Override `Date.now` for tests. */
  now?: () => number;
}

export interface VerifySignatureResult {
  ok: boolean;
  /** Why it failed, for logging. Never returned to the upstream
   *  client — leaking which check failed (signature vs timestamp)
   *  helps an attacker iterate. */
  reason?: "bad-signature" | "missing-timestamp" | "replay-too-old" | "bad-timestamp";
}

const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;

export function verifyWebhookSignature(args: VerifySignatureArgs): VerifySignatureResult {
  const algorithm = args.algorithm ?? "sha256";
  const replayWindowMs = args.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
  const now = (args.now ?? Date.now)();

  // Timestamp window check first — cheap, cuts off the easy attacks.
  if (replayWindowMs > 0) {
    if (!args.timestamp) {
      return { ok: false, reason: "missing-timestamp" };
    }
    const tsMs = parseTimestamp(args.timestamp);
    if (tsMs === null) return { ok: false, reason: "bad-timestamp" };
    if (Math.abs(now - tsMs) > replayWindowMs) {
      return { ok: false, reason: "replay-too-old" };
    }
  }

  // Constant-time compare against the expected HMAC.
  const bodyBuf = typeof args.body === "string" ? Buffer.from(args.body, "utf8") : args.body;
  const expected = createHmac(algorithm, args.secret).update(bodyBuf).digest();
  const supplied = parseSignature(args.signatureHeader, algorithm);
  if (!supplied) return { ok: false, reason: "bad-signature" };
  if (supplied.length !== expected.length) return { ok: false, reason: "bad-signature" };
  return timingSafeEqual(supplied, expected)
    ? { ok: true }
    : { ok: false, reason: "bad-signature" };
}

/**
 * Parses sig header: accepts hex or base64, optionally with a
 * "sha256=" / "sha1=" / "sha512=" prefix. The prefix is validated
 * against the caller-supplied algorithm — a "sha512=..." prefix on a
 * sha256 verification is rejected so an attacker can't game the
 * parser by replaying a wrong-algorithm signature.
 */
function parseSignature(header: string, algorithm: "sha256" | "sha1" | "sha512"): Buffer | null {
  let cleaned = header;
  const prefixMatch = /^(sha1|sha256|sha512)=/.exec(header);
  if (prefixMatch) {
    if (prefixMatch[1] !== algorithm) return null;
    cleaned = header.slice(prefixMatch[0].length);
  }
  if (/^[0-9a-fA-F]+$/.test(cleaned) && cleaned.length % 2 === 0) {
    return Buffer.from(cleaned, "hex");
  }
  try {
    // base64 fallback. Buffer.from doesn't throw on non-base64; check
    // that the round-trip is lossless before trusting it.
    const buf = Buffer.from(cleaned, "base64");
    if (buf.toString("base64").replace(/=+$/, "") === cleaned.replace(/=+$/, "")) {
      return buf;
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/** Accepts ISO-8601 datetimes or unix-seconds strings. Returns ms or null. */
function parseTimestamp(raw: string): number | null {
  // Unix-seconds (digit-only) → multiply.
  if (/^\d{1,11}$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n * 1000 : null;
  }
  // Unix-milliseconds.
  if (/^\d{12,14}$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
