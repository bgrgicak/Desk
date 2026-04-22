import { test, expect } from "../fixtures";

test.describe("Runs", () => {
  test("shows runs page", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Runs" }).click();
    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  });

  test("shows runs created after sending a message", async ({ login, page }) => {
    await login();
    // Create a chat (Today.tsx sends the initial message, which triggers a run)
    await page.getByLabel("Message").first().fill("Run test chat");
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByRole("heading", { name: /Chat: Run test/ })).toBeVisible();

    // Wait for the run to complete
    await page.waitForTimeout(2000);

    // Navigate to Runs via the nav header
    await page.getByRole("navigation").getByRole("button", { name: "Runs" }).click();
    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();

    // Should see at least one run in the table
    await expect(page.locator("table tbody tr").first()).toBeVisible({ timeout: 5000 });
  });

  test("view run detail and logs", async ({ login, page }) => {
    await login();
    // Create a chat (triggers a run automatically)
    await page.getByLabel("Message").first().fill("Run detail chat");
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByRole("heading", { name: /Chat:/ })).toBeVisible();
    await page.waitForTimeout(2000);

    // Go to runs via the nav
    await page.getByRole("navigation").getByRole("button", { name: "Runs" }).click();
    await expect(page.locator("table tbody tr").first()).toBeVisible({ timeout: 5000 });

    // Click on the first run
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await expect(page.getByRole("heading", { name: /Run/ })).toBeVisible();
    await expect(page.getByText("State")).toBeVisible();
  });
});
