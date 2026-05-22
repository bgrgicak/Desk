import { type Pool } from "@agent-desk/db";
import { queries } from "@agent-desk/db";
import { ForbiddenError, UnauthorizedError } from "@agent-desk/shared";
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
const PUBLIC_EXACT = new Set(["/", "/auth/signup-status"]);
const PUBLIC_PREFIXES = ["/auth/login", "/auth/auto-login", "/auth/signup", "/openapi.json"];

// Routes under /internal/* use their own loopback + shared-secret auth
// (see auth/internal.ts). The user-session middleware skips them so the
// dispatch handler can enforce the internal contract directly.
const INTERNAL_PREFIX = "/internal/";

// Routes under /sandbox/* are called by the agent's `desk` CLI from inside
// an pi run. They authenticate via X-Desk-Sandbox-Token instead of
// a user session — see auth/sandboxToken.ts.
const SANDBOX_PREFIX = "/sandbox/";

// Routes under /apps/* serve a chat-artifact app's built static assets.
// The static GETs authenticate via a per-app HttpOnly cookie issued by
// `POST /apps/.../issue` (which itself takes the bearer session). The
// issue endpoint is the only /apps/* path that needs the bearer token,
// and we re-check it inside the dispatcher rather than gating here.
const APPS_PREFIX = "/apps/";

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
  if (url.startsWith(APPS_PREFIX)) {
    // The /apps/* dispatcher handles its own auth — static GETs use a
    // per-app HttpOnly cookie, the issue endpoint re-verifies the
    // bearer token directly. Returning "" here lets the request reach
    // the dispatcher without the global Bearer requirement firing.
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

/**
 * Endpoints the SPA still needs to call while the user is on the
 * documented public seed credential. Anything not in this set is
 * blocked with 403 until the user changes their password via POST
 * /me/password.
 *
 * The set is intentionally narrow: enough to render the password-
 * change UI (GET /me, GET /workspaces) and to log out / change the
 * password / probe the auth-status surface. Every other route is
 * blocked.
 */
const MUST_CHANGE_PW_ALLOWED: ReadonlyArray<{ method: string; path: string | RegExp }> = [
  { method: "POST", path: "/auth/logout" },
  { method: "POST", path: "/me/password" },
  { method: "GET", path: "/me" },
  { method: "GET", path: "/auth/signup-status" },
  { method: "GET", path: "/health" },
  { method: "GET", path: "/ready" },
  { method: "GET", path: "/openapi.json" },
];

function isAllowedWhileMustChange(method: string, url: string): boolean {
  for (const entry of MUST_CHANGE_PW_ALLOWED) {
    if (entry.method !== method) continue;
    if (typeof entry.path === "string") {
      if (entry.path === url) return true;
    } else if (entry.path.test(url)) {
      return true;
    }
  }
  return false;
}

/**
 * If the user's `must_change_password` flag is set, refuse every
 * state-changing endpoint until they call POST /me/password. The
 * allowlist above covers what the SPA needs to render the prompt and
 * the password-change form.
 *
 * Called from the request dispatcher in app.ts after requireAuth has
 * resolved the userId. Returns nothing on success; throws
 * ForbiddenError with a specific code on rejection so the SPA can
 * recognise the state and redirect to the change-password screen.
 */
export async function enforceMustChangePassword(
  pool: Pool,
  userId: string,
  method: string,
  url: string,
): Promise<void> {
  if (!userId) return; // unauthenticated path
  if (isAllowedWhileMustChange(method, url)) return;
  const user = await queries.users.findById(pool, userId);
  if (!user) return; // request will 401 downstream anyway
  if (user.mustChangePassword) {
    throw new ForbiddenError(
      "Password change required before this endpoint can be used",
    );
  }
}
