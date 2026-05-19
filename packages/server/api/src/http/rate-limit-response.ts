import { type ServerResponse } from "node:http";
import { consumeRateLimit } from "../auth/rateLimit.js";
import { sendJson } from "./io.js";

/**
 * Consults a named rate-limit bucket and emits a 429 if the key is
 * over budget. Returns true when a response has been written and the
 * caller should early-return.
 *
 * The Retry-After header carries the time-to-recover in seconds, with
 * a floor of 1s so well-behaved clients don't busy-loop.
 */
export function denyOverLimit(res: ServerResponse, bucket: string, key: string): boolean {
  if (!key) return false; // unknown client IP — don't block, log only
  const decision = consumeRateLimit(bucket, key);
  if (decision.allowed) return false;
  const retryAfterSec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
  res.setHeader("Retry-After", String(retryAfterSec));
  sendJson(res, 429, {
    code: "RATE_LIMITED",
    message: "Too many requests; slow down",
  });
  return true;
}
