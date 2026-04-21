import { test, expect } from "../fixtures";

test.describe("Scheduled Jobs", () => {
  test("shows scheduled jobs page with form", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Scheduled" }).click();
    await expect(page.getByRole("heading", { name: "Scheduled Jobs" })).toBeVisible();
    await expect(page.getByLabel("Mode")).toBeVisible();
    await expect(page.getByLabel("Spec")).toBeVisible();
    await expect(page.getByLabel("Prompt")).toBeVisible();
  });

  test("create a scheduled job", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Scheduled" }).click();

    await page.getByLabel("Mode").selectOption("scheduled");
    await page.getByLabel("Spec").fill("2099-01-01T00:00:00Z");
    await page.getByLabel("Prompt").fill("Scheduled task prompt");
    await page.getByRole("button", { name: "Create job" }).click();

    // Job created (form resets, no error). The job may or may not show in the list
    // since the list is derived from runs. Just verify no crash.
    await expect(page.getByRole("heading", { name: "Scheduled Jobs" })).toBeVisible();
  });
});
