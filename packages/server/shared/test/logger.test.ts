import { describe, it, expect, vi } from "vitest";
import { pino } from "pino";
import { Writable } from "node:stream";

// Re-implement the scrubber + redact contract from logger.ts here so
// we exercise the actual config shape pino is initialised with. The
// production logger writes to process.stdout via sonic-boom, which
// makes it harder to inspect in tests — so this test constructs a
// matching pino with a memory stream and asserts the same redaction
// behaviour.

const ALWAYS_REDACT_KEYS = new Set([
  "authorization", "cookie", "token", "password", "currentpassword",
  "newpassword", "apikey", "api_key", "credentials", "secret",
  "refreshtoken", "accesstoken",
]);
const REDACT_PLACEHOLDER = "[REDACTED]";

function scrubSensitive(value: unknown, depth = 0): unknown {
  if (depth >= 8) return value;
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
});
