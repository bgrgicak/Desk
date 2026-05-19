import { describe, it, expect } from "vitest";
import { enforceVaultPasswordPolicy } from "../src/routes/vault.js";
import { ValidationError } from "@agent-desk/shared";

describe("enforceVaultPasswordPolicy", () => {
  it("accepts a long passphrase", () => {
    expect(() => enforceVaultPasswordPolicy("correct horse battery staple")).not.toThrow();
  });

  it("accepts exactly the minimum length", () => {
    expect(() => enforceVaultPasswordPolicy("abcdefghijkl")).not.toThrow(); // 12 chars
  });

  it("rejects passwords shorter than 12 characters", () => {
    expect(() => enforceVaultPasswordPolicy("short")).toThrow(ValidationError);
    expect(() => enforceVaultPasswordPolicy("eleven-char")).toThrow(ValidationError); // 11 chars
    expect(() => enforceVaultPasswordPolicy("")).toThrow(ValidationError);
  });

  it("rejects the documented seed password by exact match", () => {
    expect(() => enforceVaultPasswordPolicy("change-me-before-first-boot")).toThrow(ValidationError);
  });

  it("allows non-seed passwords that happen to be long enough", () => {
    expect(() => enforceVaultPasswordPolicy("change-me-before-first-boot!")).not.toThrow();
  });

  it("includes the minimum length in the error message", () => {
    try {
      enforceVaultPasswordPolicy("nope");
    } catch (err) {
      expect((err as Error).message).toContain("12");
      return;
    }
    throw new Error("expected ValidationError to be thrown");
  });
});
