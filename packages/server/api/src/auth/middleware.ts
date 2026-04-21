import { UnauthorizedError } from "@desk/shared";
import { verifySession } from "./sessions.js";

/**
 * Paths that don't require auth. Matched either exactly (for single-route
 * values) or as prefixes (so /openapi.json/anything and /auth/login stays covered
 * — we use exact comparison for "/" since a prefix match on "/" would match
 * every URL).
 */
const PUBLIC_EXACT = new Set(["/"]);
const PUBLIC_PREFIXES = ["/auth/login", "/openapi.json"];

/**
 * Extracts and validates auth from an Authorization header.
 * Returns userId on success, throws UnauthorizedError on failure.
 */
export function requireAuth(url: string, authHeader: string | undefined): string {
  if (PUBLIC_EXACT.has(url)) return "";
  for (const path of PUBLIC_PREFIXES) {
    if (url.startsWith(path)) {
      return ""; // No auth needed
    }
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid Authorization header");
  }

  const token = authHeader.slice(7);
  const userId = verifySession(token);
  if (!userId) {
    throw new UnauthorizedError("Invalid or expired session token");
  }

  return userId;
}
