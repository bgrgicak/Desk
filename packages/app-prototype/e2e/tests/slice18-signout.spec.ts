/**
 * Slice 18 — Sign-out from WorkspaceBar.
 *
 * Clicks Sign out → POST /auth/logout → token is cleared from
 * sessionStorage, the app reloads, and the LoginScreen renders.
 */
import { test, expect } from "../fixtures";

test("sign-out clears the session and renders the LoginScreen", async ({
  loggedInPage,
}) => {
  await expect(loggedInPage.getByTestId('account-avatar')).toBeVisible();

  // Open the avatar dropdown and click Sign out.
  await loggedInPage.getByTestId('account-avatar').click();
  await loggedInPage.getByTestId('sign-out-button').click();

  // After the post-logout reload the LoginScreen renders because there's
  // no token in sessionStorage.
  await expect(loggedInPage.getByTestId('login-submit')).toBeVisible({ timeout: 10_000 });

  // Token must stay cleared, not just transiently.
  expect(
    await loggedInPage.evaluate(() => sessionStorage.getItem('desk.session.token')),
  ).toBeNull();
});
