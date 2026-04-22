import { test, expect, SEED_USER, SEED_PASS } from "../fixtures";

test.describe("Session persistence", () => {
  test("token is saved to localStorage after login", async ({ login, page }) => {
    await login();
    const raw = await page.evaluate(() => localStorage.getItem("desk_session"));
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.token).toBeTruthy();
    expect(parsed.storedAt).toBeGreaterThan(0);
  });

  test("page reload restores session without re-login", async ({ login, page }) => {
    await login();
    // Verify we're logged in
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();

    // Reload the page
    await page.reload();

    // Should still be logged in — no login form
    await expect(page.getByRole("heading", { name: "Desk" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  });

  test("expired token does not restore session", async ({ page, baseURL }) => {
    // Manually set an expired token in localStorage
    await page.goto(baseURL!);
    await page.evaluate(() => {
      localStorage.setItem(
        "desk_session",
        JSON.stringify({ token: "ses_expired", storedAt: Date.now() - 25 * 60 * 60 * 1000 }),
      );
    });
    await page.reload();

    // Should show login form (expired token was rejected)
    await expect(page.getByRole("heading", { name: "Login" })).toBeVisible();

    // localStorage should have been cleared
    const raw = await page.evaluate(() => localStorage.getItem("desk_session"));
    expect(raw).toBeNull();
  });

  test("logout clears localStorage token", async ({ login, page }) => {
    await login();
    // Verify token exists
    let raw = await page.evaluate(() => localStorage.getItem("desk_session"));
    expect(raw).toBeTruthy();

    // Logout
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("button", { name: "Log out" }).click();

    // Should be on login page
    await expect(page.getByRole("heading", { name: "Login" })).toBeVisible();

    // Token should be cleared
    raw = await page.evaluate(() => localStorage.getItem("desk_session"));
    expect(raw).toBeNull();
  });
});
