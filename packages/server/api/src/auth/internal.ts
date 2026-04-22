import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { UnauthorizedError } from "@desk/shared";

let cachedToken: string | null = null;

function tokenPath(): string {
  return process.env.DESK_INTERNAL_TOKEN_PATH ?? "/etc/desk-server/internal-token";
}

/**
 * Loads the internal shared secret, generating it on first boot if missing.
 * The file is written mode 0600 so only the service user can read it.
 */
export function ensureInternalToken(): string {
  if (cachedToken) return cachedToken;

  const p = tokenPath();
  try {
    const buf = fs.readFileSync(p, "utf8").trim();
    if (buf.length < 32) {
      throw new Error(`Internal token at ${p} is too short`);
    }
    cachedToken = buf;
    return buf;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  fs.mkdirSync(path.dirname(p), { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(p, generated + "\n", { mode: 0o600 });
  cachedToken = generated;
  return generated;
}

/** Test-only: reset the cached token so a new DESK_INTERNAL_TOKEN_PATH takes effect. */
export function resetInternalTokenCache(): void {
  cachedToken = null;
}

/**
 * Middleware for routes under /internal/*. Requires:
 *   1. Remote address is 127.0.0.1 / ::1
 *   2. Authorization: Bearer <shared-secret> matches the on-disk token
 */
export function requireInternal(req: IncomingMessage): void {
  const addr = req.socket.remoteAddress ?? "";
  const isLoopback =
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1";
  if (!isLoopback) {
    throw new UnauthorizedError("Internal route requires loopback origin");
  }
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing bearer token");
  }
  const presented = header.slice("Bearer ".length).trim();
  const expected = ensureInternalToken();
  // Constant-time comparison
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new UnauthorizedError("Invalid internal token");
  }
}
