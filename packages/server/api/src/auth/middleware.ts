import { type Pool, type PoolClient } from "@desk/db";
import { queries } from "@desk/db";
import { UnauthorizedError } from "@desk/shared";
import { verifySession } from "./sessions.js";

/**
 * Upserts the user's stored timezone from the `X-Client-Timezone` header
 * when it differs from what's in the DB. Tolerant: only runs for IANA-shaped
 * strings (letters/digits/`/_+-`, ≤ 64 chars), silently drops everything
 * else so a malformed header can't poison the column.
 */
const TIMEZONE_RE = /^[A-Za-z][A-Za-z0-9/_+-]{0,63}$/;

export async function recordClientTimezone(
  pool: Pool,
  userId: string,
  headerValue: string | string[] | undefined,
): Promise<void> {
  if (!userId) return;
  const tz = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!tz || !TIMEZONE_RE.test(tz)) return;
  await queries.users.setTimezoneIfChanged(pool, userId, tz);
}

/**
 * Paths that don't require auth. Matched either exactly (for single-route
 * values) or as prefixes (so /openapi.json/anything and /auth/login stays covered
 * — we use exact comparison for "/" since a prefix match on "/" would match
 * every URL).
 */
const PUBLIC_EXACT = new Set(["/"]);
const PUBLIC_PREFIXES = ["/auth/login", "/openapi.json"];

// Routes under /internal/* use their own loopback + shared-secret auth
// (see auth/internal.ts). The user-session middleware skips them so the
// dispatch handler can enforce the internal contract directly.
const INTERNAL_PREFIX = "/internal/";

// Routes under /sandbox/* are called by the agent's `desk` CLI from inside
// an OpenCode run. They authenticate via X-Desk-Sandbox-Token instead of
// a user session — see auth/sandboxToken.ts.
const SANDBOX_PREFIX = "/sandbox/";

/**
 * Extracts and validates auth from an Authorization header.
 * Returns userId on success, throws UnauthorizedError on failure.
 */
export async function requireAuth(
  pool: Pool,
  url: string,
  authHeader: string | undefined,
): Promise<string> {
  if (PUBLIC_EXACT.has(url)) return "";
  for (const path of PUBLIC_PREFIXES) {
    if (url.startsWith(path)) {
      return ""; // No auth needed
    }
  }
  if (url.startsWith(INTERNAL_PREFIX)) {
    // Defer to requireInternal() in the dispatcher.
    return "";
  }
  if (url.startsWith(SANDBOX_PREFIX)) {
    // Defer to authenticateSandboxToken() in the dispatcher.
    return "";
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid Authorization header");
  }

  const token = authHeader.slice(7);
  const userId = await verifySession(pool, token);
  if (!userId) {
    throw new UnauthorizedError("Invalid or expired session token");
  }

  return userId;
}
