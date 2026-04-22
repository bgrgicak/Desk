import { test, expect } from "../fixtures";

test.describe("Scheduled Jobs", () => {
  test("shows scheduled jobs page with form", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Scheduled" }).click();
    await expect(page.getByRole("heading", { name: "Scheduled Jobs" })).toBeVisible();
    await expect(page.getByLabel("Mode")).toBeVisible();
    await expect(page.getByLabel("When")).toBeVisible();
    await expect(page.getByLabel("Prompt")).toBeVisible();
  });

  test("create a scheduled job and see it in the table", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Scheduled" }).click();

    await page.getByLabel("Mode").selectOption("scheduled");
    await page.getByLabel("When").fill("in 5 minutes");
    await page.getByLabel("Prompt").fill("Scheduled e2e test");
    await page.getByRole("button", { name: "Create job" }).click();

    // Form should reset after successful submission
    await expect(page.getByLabel("When")).toHaveValue("");
    await expect(page.getByLabel("Prompt")).toHaveValue("");

    // The new job should appear in the table
    await expect(page.getByRole("cell", { name: "once" })).toBeVisible();
    await expect(page.getByText("now + 5 minutes")).toBeVisible();
  });

  test("cancel a scheduled job", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Scheduled" }).click();

    // Wait for existing jobs to load
    await page.waitForTimeout(500);
    const beforeCount = await page.getByRole("button", { name: "Cancel" }).count();

    // Create a job
    await page.getByLabel("When").fill("in 10 minutes");
    await page.getByLabel("Prompt").fill("To be cancelled");
    await page.getByRole("button", { name: "Create job" }).click();
    await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(beforeCount + 1);

    // Cancel the last one
    await page.getByRole("button", { name: "Cancel" }).last().click();

    // Should be back to the original count
    await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(beforeCount);
  });
});
