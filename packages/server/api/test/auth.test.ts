import { describe, it, expect, afterEach } from "vitest";
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
});
