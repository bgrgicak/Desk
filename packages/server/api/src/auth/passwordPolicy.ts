import { ValidationError } from "@roomy-ai/shared";

/**
 * Single source of truth for user-account password rules.
 *
 * Called from three sites today:
 *   - POST /auth/signup   (auth.handleSignup)
 *   - POST /me/password   (account.changePassword)
 *   - POST /vault/setup   (vault.enforceVaultPasswordPolicy delegates
 *                          here so the vault password and the user
 *                          password follow the same minimum bar)
 *
 * NIST 800-63B favors length over composition rules.  We enforce a
 * 12-char minimum plus a single explicit reject for the documented
 * public seed string so a first-boot operator cannot accidentally
 * keep that credential by typing it into the change-password form.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const SEED_PASSWORD = "change-me-before-first-boot";

export function enforcePasswordPolicy(password: string): void {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    throw new ValidationError(
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    );
  }
  if (password === SEED_PASSWORD) {
    throw new ValidationError(
      "Password must differ from the default seed password",
    );
  }
}
