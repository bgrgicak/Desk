import { describe, it, expect, afterEach, vi } from "vitest";
import { issueSession, revokeSession, verifySession, clearSessions } from "../src/auth/sessions.js";

afterEach(() => {
  clearSessions();
});

describe("session store", () => {
  it("issueSession returns a ses_ prefixed token", () => {
    const token = issueSession("usr_test");
    expect(token).toMatch(/^ses_/);
  });

  it("verifySession returns userId for valid token", () => {
    const token = issueSession("usr_test");
    expect(verifySession(token)).toBe("usr_test");
  });

  it("verifySession returns null for unknown token", () => {
    expect(verifySession("ses_unknown")).toBeNull();
  });

  it("revokeSession invalidates the token", () => {
    const token = issueSession("usr_test");
    expect(revokeSession(token)).toBe(true);
    expect(verifySession(token)).toBeNull();
  });

  it("revokeSession returns false for unknown token", () => {
    expect(revokeSession("ses_unknown")).toBe(false);
  });

  it("verifySession returns null for tokens older than 7 days", () => {
    vi.useFakeTimers();
    try {
      const token = issueSession("usr_test");
      vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 1);
      expect(verifySession(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("verifySession still returns userId just before 7-day expiry", () => {
    vi.useFakeTimers();
    try {
      const token = issueSession("usr_test");
      vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 - 1000);
      expect(verifySession(token)).toBe("usr_test");
    } finally {
      vi.useRealTimers();
    }
  });
});
