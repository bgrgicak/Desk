/**
 * Validation helpers for the forced-password-change screen.
 *
 * Extracted from the React component so the predicate behavior can
 * be exercised by a unit test without booting jsdom or @testing-
 * library/react.  Mirrors the server-side `enforcePasswordPolicy`
 * (12-char min + reject documented seed verbatim) so the inline UI
 * errors never drift from what `POST /me/password` will accept.
 *
 * The screen feeds the user's current input straight into these
 * functions on every render; they are intentionally pure.
 */

/** Documented public seed credential — must not be reused. */
export const PUBLIC_SEED_PASSWORD = "change-me-before-first-boot";

/** Minimum length the server's enforcePasswordPolicy requires. */
export const PASSWORD_MIN_LENGTH = 12;

export interface PasswordCheckInput {
  newPassword: string;
  confirmPassword: string;
}

export interface PasswordCheckResult {
  /** Submit button enabled state. */
  canSubmit: boolean;
  /** True when the user has typed something but it's < min length. */
  tooShort: boolean;
  /** True when the new password is the documented seed value. */
  isSeed: boolean;
  /** True when newPassword and confirmPassword disagree. */
  passwordMismatch: boolean;
}

export function evaluatePasswordChange(
  input: PasswordCheckInput,
): PasswordCheckResult {
  const { newPassword, confirmPassword } = input;
  const passwordMismatch =
    newPassword.length > 0 &&
    confirmPassword.length > 0 &&
    newPassword !== confirmPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < PASSWORD_MIN_LENGTH;
  const isSeed = newPassword === PUBLIC_SEED_PASSWORD;
  const canSubmit =
    newPassword.length >= PASSWORD_MIN_LENGTH &&
    !isSeed &&
    !passwordMismatch &&
    confirmPassword.length > 0;
  return { canSubmit, tooShort, isSeed, passwordMismatch };
}
