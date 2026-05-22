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

// Field names that always look like secrets regardless of context.
// pino's fast-redact only supports single-segment `*` wildcards, so
// deep nesting (`a.b.token`, `err.cause.user.token`) would leak with
// a pure path list. We pre-walk every log object through
// `scrubSensitive()` (below) — that handles arbitrary depth and
// covers the cases pino's path syntax can't.
//
// This is the *exact-match* allowlist, kept as a fallback for common
// header/field names. Most provider-key leaks come from
// `<PROVIDER>_API_KEY` / `<PROVIDER>_TOKEN` style names, which the
// universal pattern below catches even when this set doesn't list
// the exact provider.
const ALWAYS_REDACT_KEYS = new Set([
  "authorization",
  "cookie",
  "credentials",
  // AWS pair: the secret-access-key matches the universal pattern via
  // its trailing `_secret_access_key`; the access-key-id ends in `_id`
  // which the universal "secret suffix" rule deliberately excludes
  // (to avoid redacting workspace_id, request_id, etc.). List the
  // exact name here so AWS auth pairs don't half-leak.
  "aws_access_key_id",
]);

// Universal secret-name pattern: matches keys whose name ENDS in a
// secret-shaped token. Case-insensitive. Covers every `*_API_KEY`,
// `*_TOKEN`, `*_SECRET`, `*_PASSWORD` we've added or will add
// (ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, GITHUB_TOKEN,
// SLACK_BOT_TOKEN, AWS_SECRET_ACCESS_KEY, PI_AUTH_JSON_BASE64,
// REFRESH_TOKEN, ACCESS_TOKEN, …) without an explicit allowlist.
//
// Why suffix-only (not prefix): `password_strength_score` and
// `tokens_used` are counters / scores, not secrets. Anchoring to the
// END (preceded by separator OR start-of-string) means
// `STRIPE_API_KEY` matches but `password_strength_score` doesn't.
// The plural `tokens` is deliberately not a secret pattern —
// `input_tokens` / `output_tokens` / `max_tokens` are LLM-cost
// counters that show up in every log line and would flood the log
// with [REDACTED] if matched.
//
// Test coverage in shared/test/logger.test.ts pins down both halves.
const SECRET_NAME_RE =
  /(^|[_\-.])(api[_\-.]?key|secret[_\-.]?key|access[_\-.]?key|client[_\-.]?secret|secret[_\-.]?access[_\-.]?key|auth[_\-.]?content|auth[_\-.]?token|access[_\-.]?token|refresh[_\-.]?token|bearer[_\-.]?token|session[_\-.]?token|id[_\-.]?token|server[_\-.]?password|password|passphrase|apikey|api_key|secret|token)$/i;

function isSecretName(key: string): boolean {
  // Normalise camelCase / PascalCase into snake_case so the
  // secret-suffix regex matches `anthropicApiKey`, `refreshToken`,
  // `bearerToken`, etc. — the SDK-style names that appear in TS
  // payloads as opposed to env-style names from process.env.
  const normalised = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (ALWAYS_REDACT_KEYS.has(normalised)) return true;
  return SECRET_NAME_RE.test(normalised);
}

const REDACT_PLACEHOLDER = "[REDACTED]";
const MAX_SCRUB_DEPTH = 8; // belt + suspenders against accidental cycles

/**
 * Recursively replaces values at any depth whose key looks like a
 * secret with [REDACTED]. Returns a new object so the caller's data
 * isn't mutated. Pino's fast-redact would do this natively if it
 * supported `**` paths — until then we run our own walker.
 *
 * Matches a *universal* secret-name pattern (see `SECRET_NAME_RE`),
 * not a fixed list — so a future `STRIPE_API_KEY` or
 * `NOTION_SECRET` is redacted on the first log line that mentions
 * it, no allowlist update required.
 */
export function scrubSensitive(value: unknown, depth = 0): unknown {
  if (depth >= MAX_SCRUB_DEPTH) return value;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => scrubSensitive(v, depth + 1));
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretName(k)) {
      out[k] = REDACT_PLACEHOLDER;
    } else {
      out[k] = scrubSensitive(v, depth + 1);
    }
  }
  return out;
}

/** Test-only export of the secret-name predicate. */
export const _isSecretNameForTest = isSecretName;

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
