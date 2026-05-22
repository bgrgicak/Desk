/**
 * Direct coverage of the shared password-policy helper.
 *
 * Three callers (/auth/signup, /me/password, /vault/setup) all
 * delegate to `enforcePasswordPolicy`; if the helper drifts, every
 * password-setting surface drifts in lockstep. This pure-function
 * test locks the contract independent of any HTTP fixture.
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@roomy-ai/shared";
import {
  enforcePasswordPolicy,
  PASSWORD_MIN_LENGTH,
  SEED_PASSWORD,
} from "../src/auth/passwordPolicy.js";

describe("enforcePasswordPolicy", () => {
  it("accepts a policy-compliant password", () => {
    expect(() => enforcePasswordPolicy("a".repeat(PASSWORD_MIN_LENGTH))).not.toThrow();
    expect(() => enforcePasswordPolicy("mixed Letters 1!@#")).not.toThrow();
  });

  it("rejects passwords shorter than the configured minimum", () => {
    for (let length = 0; length < PASSWORD_MIN_LENGTH; length++) {
      expect(() => enforcePasswordPolicy("a".repeat(length))).toThrow(ValidationError);
    }
  });

  it("rejects the documented public seed value verbatim", () => {
    // Even though the seed is itself ≥ 12 chars, the helper refuses
    // it explicitly — otherwise a user on the must-change-password
    // gate could "change" to the documented value and clear the flag
    // back to its starting state.
    expect(SEED_PASSWORD.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
    expect(() => enforcePasswordPolicy(SEED_PASSWORD)).toThrow(/seed password/i);
  });

  it("rejects non-string input via the length check (defensive)", () => {
    // Callers pass an already-narrowed string, but the helper is
    // also reached from /me/password where the body is `unknown` —
    // a missing or non-string field needs a clean ValidationError,
    // not a TypeError.
    // @ts-expect-error -- exercising the runtime guard
    expect(() => enforcePasswordPolicy(undefined)).toThrow(ValidationError);
    // @ts-expect-error -- exercising the runtime guard
    expect(() => enforcePasswordPolicy(123)).toThrow(ValidationError);
    // @ts-expect-error -- exercising the runtime guard
    expect(() => enforcePasswordPolicy(null)).toThrow(ValidationError);
  });

  it("emits messages that mention the failing condition for the inline UI to surface", () => {
    try {
      enforcePasswordPolicy("short");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(/at least/i);
    }
    try {
      enforcePasswordPolicy(SEED_PASSWORD);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toMatch(/seed password/i);
    }
  });
});
