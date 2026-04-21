import { test, expect } from "../fixtures";

test("shows login form on load", async ({ page, baseURL }) => {
  await page.goto(baseURL!);
  await expect(page.getByRole("heading", { name: "Login" })).toBeVisible();
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
});

test("shows error on invalid credentials", async ({ page, baseURL }) => {
  await page.goto(baseURL!);
  await page.getByLabel("Username").fill("baduser");
  await page.getByLabel("Password").fill("badpass");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid");
});

test("successful login shows main app", async ({ login, page }) => {
  await login();
  await expect(page.getByRole("heading", { name: "Desk" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
});
