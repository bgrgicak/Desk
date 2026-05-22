/**
 * Slice 17 — LoginScreen.
 *
 * With no stored token the app should render LoginScreen. Bad credentials
 * surface an inline error; correct credentials drop the user on a
 * workspace.
 */
import { test, expect } from "@playwright/test";

const SEED_USERNAME = "e2e";
const SEED_PASSWORD = "e2e";
const APP_URL = "http://127.0.0.1:5179";

// Clear any stored token so main.tsx renders the LoginScreen rather than
// resuming a session.
async function simulateSignedOut(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(APP_URL);
  await page.evaluate(() => {
    try {
      sessionStorage.removeItem('roomy.session.token');
    } catch { /* ignore */ }
  });
  await page.reload();
}

test("login form rejects bad credentials and accepts good ones", async ({ page }) => {
  await simulateSignedOut(page);

  await expect(page.getByTestId('login-submit')).toBeVisible();

  // Bad credentials surface inline error.
  await page.getByLabel('Username').fill('not-a-real-user');
  await page.getByLabel('Password').fill('wrong');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toBeVisible({ timeout: 5_000 });

  // Correct credentials reload into the app.
  await page.getByLabel('Username').fill(SEED_USERNAME);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByTestId('login-submit').click();

  // Should land in a workspace — the avatar is the readiness signal.
  await expect(page.getByTestId('account-avatar')).toBeVisible({ timeout: 10_000 });
});

test("signup is disabled with a 'coming soon' affordance", async ({ page }) => {
  await simulateSignedOut(page);
  await expect(page.getByTestId('signup-coming-soon')).toBeVisible();
});
