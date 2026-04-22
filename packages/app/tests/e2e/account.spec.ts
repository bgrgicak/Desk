import { test, expect } from "../fixtures";

test.describe("Account", () => {
  test("shows account page with profile form", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    await expect(page.getByLabel("Username")).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
  });

  test("update profile", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Account" }).click();

    await page.getByLabel("Email").fill("test@example.com");
    await page.getByRole("button", { name: "Save profile" }).click();

    await expect(page.getByText("Profile updated")).toBeVisible();
  });

  test("change password and change it back", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Account" }).click();

    // Change password
    await page.getByLabel("Current password").fill("testpass");
    await page.getByLabel("New password").fill("newpass123");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password changed")).toBeVisible();

    // Change it back so other tests still work
    await page.getByLabel("Current password").fill("newpass123");
    await page.getByLabel("New password").fill("testpass");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password changed")).toBeVisible();
  });

  test("change password rejects wrong current password", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Account" }).click();

    await page.getByLabel("Current password").fill("wrong-password");
    await page.getByLabel("New password").fill("newpass123");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Current password is incorrect")).toBeVisible();
  });

  test("logout returns to login form", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.getByRole("heading", { name: "Login" })).toBeVisible();
  });

  test("delete account button is present", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Account" }).click();
    // Verify the delete button exists (don't actually click it — it would
    // destroy the test user and break subsequent tests in the shared DB)
    await expect(page.getByRole("button", { name: "Delete account" })).toBeVisible();
  });
});
