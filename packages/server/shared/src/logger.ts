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

const REDACT_PATHS = [
  // Auth header values (rare in logs, but never leak). Cover top-level
  // and the common nesting patterns (axios-style err.config.headers,
  // node http err.req.headers).
  "req.headers.authorization",
  "headers.authorization",
  "authorization",
  "*.headers.authorization",
  "err.config.headers.authorization",
  // Cookies can carry session bearer tokens.
  "req.headers.cookie",
  "headers.cookie",
  "cookie",
  "*.headers.cookie",
  // Token query params on /ws upgrade etc. Wildcards catch nested
  // contexts (e.g. log.error({user: {token}}, ...)).
  "token",
  "*.token",
  "password",
  "*.password",
  "currentPassword",
  "newPassword",
  // Provider/connection credentials.
  "apiKey",
  "*.apiKey",
  "api_key",
  "*.api_key",
  "credentials",
  "*.credentials",
  "secret",
  "*.secret",
  // Error objects that get logged via {err}. Common nesting comes
  // through axios (err.config), fetch errors (err.cause), and pg
  // (err.where/err.detail can carry table contents).
  "err.config",
  "err.cause",
  "err.config.data",
  "err.response.data",
];

const root: PinoLogger = pino({
  level: process.env.DESK_LOG_LEVEL ?? "info",
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
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
