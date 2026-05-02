/**
 * Slice 1 — session & bootstrap.
 *
 * After logging in with the seeded creds, the app must:
 *   - render the main shell,
 *   - fetch /me,
 *   - show initials derived from the seeded user in the account avatar.
 */
import { test, expect } from "../fixtures";

test("app boots with a seeded session and shows user initials", async ({
  loggedInPage,
}) => {
  // Seeded user is "e2e" → initials derive from the username.
  const avatar = loggedInPage.getByTestId("account-avatar");
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveText(/^E/i);
});
