/**
 * Server-wide structured logger. Thin wrapper around pino so the
 * server has a single source of truth for log shape and so the
 * `no-console` lint rule has a place to point disciplined callers at.
 *
 * The wrapper is deliberately small — no transports, no rotation, no
 * formatters. desk-server writes JSON-per-line to stdout/stderr; an
 * operator running it under systemd / launchd captures the stream into
 * a journal / log file of their choice. Pretty-printing for human
 * readers stays out of the binary (no `pino-pretty` dependency); use
 * `pino-pretty` from the host shell when tailing.
 *
 * Why pino specifically:
 * - lowest-allocation JSON logger in the Node ecosystem (the per-call
 *   cost matters; the SQLite pool now calls into the logger on every
 *   slow query, every request emits at least one line, etc.)
 * - supports `redact` paths natively so PII redaction lives in the
 *   logger config instead of in each call site
 * - child loggers are zero-cost — `log.child({ request_id })` is the
 *   request-scoped pattern.
 *
 * Levels: `debug`, `info`, `warn`, `error`, `fatal`. `info` is the
 * default at runtime; set `DESK_LOG_LEVEL` to override.
 */

import { pino, type Logger as PinoLogger } from "pino";

// Field names that are always redacted regardless of depth. pino's
// fast-redact only supports single-segment `*` wildcards, so deep
// nesting (`a.b.token`, `err.cause.user.token`) would leak with a
// pure path list. We pre-walk every log object through
// `scrubSensitive()` (below) — that handles arbitrary depth and
// covers the cases pino's path syntax can't.
const ALWAYS_REDACT_KEYS = new Set([
  "authorization",
  "cookie",
  "token",
  "password",
  "currentpassword",
  "newpassword",
  "apikey",
  "api_key",
  "credentials",
  "secret",
  "refreshtoken",
  "accesstoken",
]);

const REDACT_PLACEHOLDER = "[REDACTED]";
const MAX_SCRUB_DEPTH = 8; // belt + suspenders against accidental cycles

/**
 * Recursively replaces values at any depth whose key looks like a
 * secret with [REDACTED]. Returns a new object so the caller's data
 * isn't mutated. Pino's fast-redact would do this natively if it
 * supported `**` paths — until then we run our own walker.
 */
function scrubSensitive(value: unknown, depth = 0): unknown {
  if (depth >= MAX_SCRUB_DEPTH) return value;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => scrubSensitive(v, depth + 1));
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (ALWAYS_REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = REDACT_PLACEHOLDER;
    } else {
      out[k] = scrubSensitive(v, depth + 1);
    }
  }
  return out;
}

// pino path-based redact runs in addition to the scrubber. The
// scrubber handles the deep cases; the path list locks down a few
// well-known surfaces where the key is something we couldn't catch
// by name (e.g. `req.headers["authorization"]` already gets caught
// by ALWAYS_REDACT_KEYS, but listing it here doubles up for safety).
const REDACT_PATHS = [
  "req.headers.authorization",
  "headers.authorization",
  "authorization",
  "req.headers.cookie",
  "headers.cookie",
  "cookie",
];

const root: PinoLogger = pino({
  level: process.env.DESK_LOG_LEVEL ?? "info",
  redact: {
    paths: REDACT_PATHS,
    censor: REDACT_PLACEHOLDER,
    remove: false,
  },
  // Standardise the timestamp field so downstream log shippers don't
  // have to guess. ISO-8601 UTC matches the on-disk DB convention.
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
  formatters: {
    // Emit `level: "info"` instead of `level: 30` — humans read this
    // more often than parsers in our setup.
    level(label) {
      return { level: label };
    },
    // Walk every log object through scrubSensitive so deeply-nested
    // secrets (e.g. err.cause.user.token, an axios response payload
    // with a refresh token, a webhook event with an apiKey field)
    // are redacted regardless of where they sit in the tree.
    log(object) {
      return scrubSensitive(object) as Record<string, unknown>;
    },
  },
});

export type Logger = PinoLogger;

/** Root server logger. Prefer `withModule()` from boundary modules. */
export const log: Logger = root;

/**
 * Module-scoped child logger. Use at the top of a server module:
 *
 *     import { withModule } from "@agent-desk/shared/logger";
 *     const log = withModule("scheduler.runs");
 *
 * The resulting child carries `{ module: "scheduler.runs" }` on every
 * line so logs can be filtered without grepping message text.
 */
export function withModule(moduleName: string): Logger {
  return root.child({ module: moduleName });
}

/**
 * Request-scoped child logger. Use inside a request handler when you
 * want every log line tied back to the originating HTTP request. The
 * caller provides a stable id; usually a `crypto.randomUUID()` minted
 * at request entry.
 */
export function withRequest(requestId: string, userId?: string): Logger {
  return root.child(userId ? { request_id: requestId, user_id: userId } : { request_id: requestId });
}

// Re-export the underlying type so consumers don't have to depend on
// pino directly.
export type { PinoLogger };
