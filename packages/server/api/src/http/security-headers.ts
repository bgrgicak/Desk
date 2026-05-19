import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Default security headers applied to every response before route
 * dispatch. Use setHeader (not writeHead) so the values are merged
 * with whatever status-specific headers the handler emits later.
 *
 * - X-Content-Type-Options: nosniff blocks MIME-sniffing on JSON/text
 *   payloads.
 * - Referrer-Policy: strict-origin-when-cross-origin keeps full URLs
 *   out of cross-origin Referer headers (vault/route IDs leak via the
 *   path).
 * - Permissions-Policy: deny powerful features by default. The SPA
 *   only needs clipboard-write; keep the rest off so a future app
 *   iframe can't probe the host's capabilities through the bridge.
 * - X-Frame-Options: DENY for everything except /apps/* (which
 *   deliberately serves iframed user apps). Same-origin embedding is
 *   still OK because the value is DENY only when no explicit setting
 *   is applied later.
 *
 * Content-Security-Policy is intentionally not set here yet — the
 * SPA's inline assets and the /apps/* iframe origin each need their
 * own policy and require a focused follow-up.
 */
export function setSecurityHeaders(req: IncomingMessage, res: ServerResponse, path: string): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=(), usb=(), payment=(), magnetometer=(), gyroscope=(), accelerometer=()",
  );
  // /apps/* is the deliberate iframe surface — leave it embeddable.
  if (!path.startsWith("/apps/")) {
    res.setHeader("X-Frame-Options", "DENY");
  }
  // HSTS only over HTTPS (Node has no native TLS here, so detect via
  // forwarded proto). Avoids broken caching when a reverse proxy is
  // present on plain HTTP.
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  if (proto === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

/**
 * Allowlist of HTTP origins permitted to open a WebSocket against /ws.
 * Resolved once at module load — the env var change requires a restart,
 * which matches every other server-side config.
 *
 * Browsers always include the Origin header on WS upgrade requests, so
 * an allowlist here mitigates Cross-Site WebSocket Hijacking (CSWSH):
 * an attacker page can't open a /ws connection on behalf of a user
 * who happens to have a session token in localStorage. Non-browser
 * clients (curl, the Postman runner, integration tests) may omit
 * Origin entirely — those continue to work because CSWSH only applies
 * to script-initiated upgrades from a browser tab.
 *
 * The default policy is "any localhost/127.0.0.1 port + the env-
 * configured production origins." Loopback can never be reached from
 * a third-party attacker page that's hosted on the public internet
 * — the browser resolves 127.0.0.1 inside the victim's box — so this
 * is the right shape for a self-hosted single-machine product where
 * the SPA, Vite dev server, Vite preview (Playwright e2e), and the
 * Electron renderer all live on loopback but on different, sometimes
 * random, ports.
 *
 * Operators putting Desk behind a reverse proxy on the public
 * internet set DESK_ALLOWED_ORIGINS to a comma-separated list of the
 * real origins; the env list is treated as exact additional matches
 * on top of the loopback rule.
 */
export function getAllowedWsOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const fromEnv = (env.DESK_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(fromEnv);
}

const ALLOWED_WS_ORIGINS = getAllowedWsOrigins();

// Loopback origin matcher. Covers:
// - localhost
// - 127.0.0.0/8 (any 127.* host)
// - [::1]              (IPv6 loopback, bracketed)
// - [::ffff:127.x.x.x] (IPv4-mapped IPv6 loopback that some browsers
//                       and Node versions report)
const LOOPBACK_ORIGIN_PATTERN =
  /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\]|\[::ffff:127(?:\.\d{1,3}){3}\])(:\d+)?$/;

/**
 * True when `addr` is a loopback IP. Shared by the WS Origin check
 * (matches against the host part of an origin URL) and the
 * /auth/auto-login dispatcher (matches against req.socket.remoteAddress
 * directly). Covers 127.0.0.0/8 and the two IPv6 loopback shapes Node
 * emits.
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === "::1") return true;
  if (addr.startsWith("::ffff:127.")) return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(addr)) return true;
  return addr === "localhost"; // some clients pass the name through
}

export function isWsOriginAllowed(
  origin: string | undefined,
  allowed: Set<string> = ALLOWED_WS_ORIGINS,
): boolean {
  // Missing Origin means the client isn't a browser-script upgrade — let
  // it through so CLI tools, integration tests and the Electron renderer
  // (when it eventually starts emitting one) keep working.
  if (!origin) return true;
  // Loopback origins are always allowed. CSWSH attacks must originate
  // from an attacker-controlled page in the victim's browser; that page
  // cannot legitimately serve from 127.0.0.1 / localhost on the
  // victim's machine.
  if (LOOPBACK_ORIGIN_PATTERN.test(origin)) return true;
  return allowed.has(origin);
}
