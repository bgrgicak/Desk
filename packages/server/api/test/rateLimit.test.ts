import { describe, it, expect, beforeEach } from "vitest";
import {
  clearRateLimits,
  consumeRateLimit,
  defineRateLimit,
} from "../src/auth/rateLimit.js";

defineRateLimit("test.bucket", { windowMs: 1_000, max: 3 });
defineRateLimit("test.tight", { windowMs: 60_000, max: 1 });

beforeEach(() => {
  clearRateLimits();
});

describe("consumeRateLimit", () => {
  it("allows the first N hits within the window", () => {
    expect(consumeRateLimit("test.bucket", "k1", 0).allowed).toBe(true);
    expect(consumeRateLimit("test.bucket", "k1", 100).allowed).toBe(true);
    expect(consumeRateLimit("test.bucket", "k1", 200).allowed).toBe(true);
  });

  it("denies the N+1th hit and reports a positive retryAfterMs", () => {
    consumeRateLimit("test.bucket", "k1", 0);
    consumeRateLimit("test.bucket", "k1", 100);
    consumeRateLimit("test.bucket", "k1", 200);
    const denied = consumeRateLimit("test.bucket", "k1", 250);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it("forgets old hits once they fall out of the sliding window", () => {
    consumeRateLimit("test.bucket", "k1", 0);
    consumeRateLimit("test.bucket", "k1", 0);
    consumeRateLimit("test.bucket", "k1", 0);
    // 1100ms later, the original three hits are all out of the 1000ms window
    expect(consumeRateLimit("test.bucket", "k1", 1100).allowed).toBe(true);
  });

  it("scopes independently per key", () => {
    consumeRateLimit("test.tight", "alice", 0);
    expect(consumeRateLimit("test.tight", "alice", 1).allowed).toBe(false);
    // bob is fresh
    expect(consumeRateLimit("test.tight", "bob", 1).allowed).toBe(true);
  });

  it("scopes independently per bucket", () => {
    consumeRateLimit("test.tight", "k", 0);
    expect(consumeRateLimit("test.tight", "k", 1).allowed).toBe(false);
    // a different bucket name shares the key but not the budget
    expect(consumeRateLimit("test.bucket", "k", 1).allowed).toBe(true);
  });

  it("throws on an unknown bucket", () => {
    expect(() => consumeRateLimit("does.not.exist", "k")).toThrow(/Unknown rate-limit bucket/);
  });

  it("clearRateLimits resets one bucket without touching another", () => {
    consumeRateLimit("test.tight", "alice", 0);
    consumeRateLimit("test.bucket", "alice", 0);
    clearRateLimits("test.tight");
    expect(consumeRateLimit("test.tight", "alice", 1).allowed).toBe(true);
    // test.bucket still has 1 hit recorded; remaining budget is 2
    expect(consumeRateLimit("test.bucket", "alice", 1).allowed).toBe(true);
    expect(consumeRateLimit("test.bucket", "alice", 1).allowed).toBe(true);
    expect(consumeRateLimit("test.bucket", "alice", 1).allowed).toBe(false);
  });
});
