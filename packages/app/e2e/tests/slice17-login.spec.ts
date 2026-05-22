/**
 * Slice 17 — LoginScreen.
 *
 * With no stored token the app should render LoginScreen. Bad credentials
 * surface an inline error; correct credentials drop the user on a
 * workspace.
 */
import { test, expect } from "@playwright/test";

const SEED_EMAIL = "e2e@roomy.local";
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
  await page.getByLabel('Email').fill('nobody@example.invalid');
  await page.getByLabel('Password').fill('wrong');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toBeVisible({ timeout: 5_000 });

  // Correct credentials reload into the app.
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByTestId('login-submit').click();

  // Should land in a workspace — the avatar is the readiness signal.
  await expect(page.getByTestId('account-avatar')).toBeVisible({ timeout: 10_000 });
});

test("signup affordance is hidden when ROOMY_ENABLE_SIGNUP is off", async ({ page }) => {
  await simulateSignedOut(page);
  // Login form must still render, but neither signup affordance.
  await expect(page.getByTestId('login-submit')).toBeVisible();
  await expect(page.getByTestId('signup-link')).toHaveCount(0);
  await expect(page.getByTestId('signup-coming-soon')).toHaveCount(0);
});
