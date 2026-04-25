/**
 * Slice 18 — Sign-out from WorkspaceBar.
 *
 * Clicks Sign out → POST /auth/logout → token is cleared from
 * sessionStorage, the sticky `signed_out` flag is set, the app reloads,
 * and the LoginScreen renders (no auto-relogin).
 */
import { test, expect } from "../fixtures";

test("sign-out clears the session and renders the LoginScreen", async ({
  loggedInPage,
}) => {
  await expect(loggedInPage.getByTestId('account-avatar')).toBeVisible();

  // Open the avatar dropdown and click Sign out.
  await loggedInPage.getByTestId('account-avatar').click();
  await loggedInPage.getByTestId('sign-out-button').click();

  // The sticky signed_out flag in auto-login.ts must short-circuit
  // ensureSession() on the post-logout reload, so the LoginScreen
  // renders instead of silently re-authenticating.
  await expect(loggedInPage.getByTestId('login-submit')).toBeVisible({ timeout: 10_000 });

  // Token must stay cleared, not just transiently.
  expect(
    await loggedInPage.evaluate(() => sessionStorage.getItem('desk.session.token')),
  ).toBeNull();
  expect(
    await loggedInPage.evaluate(() => localStorage.getItem('desk.session.signed_out')),
  ).toBe('1');
});
