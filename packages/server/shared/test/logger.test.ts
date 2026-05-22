import { describe, it, expect } from "vitest";
import { pino } from "pino";
import { Writable } from "node:stream";
// Import the production scrubber so the test exercises the actual
// implementation, not a copy that can silently drift from it.
import { scrubSensitive, _isSecretNameForTest as isSecretName } from "../src/logger.js";

const REDACT_PLACEHOLDER = "[REDACTED]";

function makeLogger(): { log: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _e, cb) {
      lines.push(chunk.toString("utf8"));
      cb();
    },
  });
  const log = pino(
    {
      level: "info",
      redact: {
        paths: ["authorization", "cookie"],
        censor: REDACT_PLACEHOLDER,
        remove: false,
      },
      formatters: {
        log(object) {
          return scrubSensitive(object) as Record<string, unknown>;
        },
      },
    },
    stream,
  );
  return { log, lines };
}

describe("logger redaction depth coverage", () => {
  it("redacts top-level sensitive fields", () => {
    const { log, lines } = makeLogger();
    log.info({ token: "secret-top" }, "msg");
    expect(lines.join()).toContain("[REDACTED]");
    expect(lines.join()).not.toContain("secret-top");
  });

  it("redacts depth-1 nesting (pino's `*.token` shape)", () => {
    const { log, lines } = makeLogger();
    log.info({ user: { token: "secret-1" } }, "msg");
    expect(lines.join()).not.toContain("secret-1");
  });

  it("redacts depth-2 nesting (where pino's `*.token` failed)", () => {
    const { log, lines } = makeLogger();
    log.info({ a: { b: { token: "secret-2" } } }, "msg");
    expect(lines.join()).not.toContain("secret-2");
  });

  it("redacts depth-3 nesting (err.cause-style)", () => {
    const { log, lines } = makeLogger();
    log.info(
      { err: { cause: { config: { headers: { authorization: "Bearer leaked-3" } } } } },
      "msg",
    );
    expect(lines.join()).not.toContain("leaked-3");
  });

  it("redacts password / apiKey / credentials / refreshToken at any depth", () => {
    const { log, lines } = makeLogger();
    log.info(
      {
        user: {
          profile: {
            password: "pwd",
            apiKey: "ak",
            credentials: { primary: "primary" },
            refreshToken: "rt",
          },
        },
      },
      "msg",
    );
    const joined = lines.join();
    expect(joined).not.toContain("pwd");
    expect(joined).not.toContain('"ak"');
    expect(joined).not.toContain("primary");
    expect(joined).not.toContain('"rt"');
  });

  it("redacts inside arrays of objects", () => {
    const { log, lines } = makeLogger();
    log.info({ items: [{ token: "in-array" }, { other: "fine" }] }, "msg");
    const joined = lines.join();
    expect(joined).not.toContain("in-array");
    expect(joined).toContain("fine");
  });

  it("is case-insensitive on the key name", () => {
    const { log, lines } = makeLogger();
    log.info({ APIKey: "case-1", Token: "case-2" }, "msg");
    const joined = lines.join();
    expect(joined).not.toContain("case-1");
    expect(joined).not.toContain("case-2");
  });

  it("leaves non-sensitive fields intact", () => {
    const { log, lines } = makeLogger();
    log.info({ user_id: "usr_abc", count: 7, deeply: { nested: "fine" } }, "msg");
    const joined = lines.join();
    expect(joined).toContain("usr_abc");
    expect(joined).toContain('"count":7');
    expect(joined).toContain("fine");
  });

  it("stops at MAX_SCRUB_DEPTH (no infinite recursion on cycles)", () => {
    const { log, lines } = makeLogger();
    // Pino + JSON.stringify reject cycles natively, but make sure
    // the scrubber bails before stack overflow on deeply-nested data.
    let leaf: Record<string, unknown> = { token: "deep-leaf" };
    for (let i = 0; i < 15; i++) leaf = { wrap: leaf };
    log.info(leaf, "msg");
    // The leaf at depth 15 is past MAX_SCRUB_DEPTH (8), so its
    // token won't be redacted. That's the documented trade-off —
    // we'd rather log unscrubbed than refuse the log entirely.
    // Below MAX_SCRUB_DEPTH the redaction works (covered above).
    expect(lines.length).toBeGreaterThan(0);
  });

  it("redacts provider-prefixed API keys without an allowlist update", () => {
    // The universal SECRET_NAME_RE must catch any *_API_KEY /
    // *_TOKEN / *_SECRET pattern so a brand-new provider env var
    // doesn't leak the first time it's logged.
    const { log, lines } = makeLogger();
    log.info(
      {
        ANTHROPIC_API_KEY: "sk-ant-leak-1",
        OPENAI_API_KEY: "sk-openai-leak-2",
        GROQ_API_KEY: "gsk-leak-3",
        STRIPE_API_KEY: "sk_live_leak-4",
        NOTION_SECRET: "secret_leak-5",
        SLACK_BOT_TOKEN: "xoxb-leak-6",
        AWS_SECRET_ACCESS_KEY: "leak-7",
        PI_AUTH_JSON_BASE64: "leak-8",
        REFRESH_TOKEN: "leak-9",
        bearerToken: "leak-10",
      },
      "msg",
    );
    const joined = lines.join();
    for (const leak of [
      "sk-ant-leak-1", "sk-openai-leak-2", "gsk-leak-3", "sk_live_leak-4",
      "secret_leak-5", "xoxb-leak-6", "leak-7", "leak-8", "leak-9",
      "leak-10",
    ]) {
      expect(joined).not.toContain(leak);
    }
  });

  it("predicate: known secret-shaped names", () => {
    // Whole-word / suffix matches across the patterns the regex covers.
    for (const name of [
      "ANTHROPIC_API_KEY", "anthropic_api_key", "anthropicApiKey",
      "OPENAI_API_KEY", "GROQ_API_KEY", "AZURE_API_KEY", "PERPLEXITY_API_KEY",
      "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "aws_session_token",
      "GITHUB_TOKEN", "GH_TOKEN", "SLACK_BOT_TOKEN", "BEARER_TOKEN",
      "REFRESH_TOKEN", "ACCESS_TOKEN", "ID_TOKEN", "SESSION_TOKEN",
      "STRIPE_API_KEY", "NOTION_SECRET", "WEBHOOK_SECRET",
      "Authorization", "cookie", "api_key", "apikey", "password",
      "passphrase", "client_secret", "credentials",
    ]) {
      expect(isSecretName(name)).toBe(true);
    }
  });

  it("predicate: leaves non-secret names alone (LLM-cost counters, ids, etc.)", () => {
    for (const name of [
      "tokenizer", "tokenize",
      "password_strength_score", // not anchored at end → not matched
      "user_id", "username", "email", "count", "timestamp",
      "max_tokens", "tokens_used", "input_tokens", "output_tokens",
      "model", "modelId", "providerId", "session_id", "chat_id",
      "request_id", "trace_id", "workspace_id",
    ]) {
      expect(isSecretName(name)).toBe(false);
    }
    // Counter pluralization must NOT match (telemetry).
    expect(isSecretName("tokens_used")).toBe(false);
    // But the SINGULAR secret suffix MUST match.
    expect(isSecretName("session_token")).toBe(true);
    expect(isSecretName("access_token")).toBe(true);
    // `tokenizer_chars_per_token` ends in `_token` → matches.
    // That's an accepted false-positive: it's only a counter unit, no
    // secret is exposed, and pinning it down would require a denylist
    // of counter shapes that's fragile. The cost is one extra
    // `[REDACTED]` in a debug log line; the benefit is "any future
    // `*_TOKEN` env-shape leaks zero secrets on first appearance."
    expect(isSecretName("tokenizer_chars_per_token")).toBe(true);
  });
});
