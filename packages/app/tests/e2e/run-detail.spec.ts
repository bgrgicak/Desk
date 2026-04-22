import { test, expect } from "../fixtures";

test.describe("Run detail", () => {
  test("clicking a run does not crash and shows run detail", async ({ login, page }) => {
    await login();

    // Create a chat (Today.tsx sends the initial message, triggering a run)
    await page.getByLabel("Message").first().fill("Run detail test");
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByRole("heading", { name: /Chat:/ })).toBeVisible();
    await page.waitForTimeout(2000);

    // Navigate to runs
    await page.getByRole("navigation").getByRole("button", { name: "Runs" }).click();
    await expect(page.locator("table tbody tr").first()).toBeVisible({ timeout: 5000 });

    // Click on the first run — this previously crashed because payload was an object
    await page.locator("table tbody tr").first().getByRole("link").first().click();

    // Verify the run detail page rendered correctly
    await expect(page.getByRole("heading", { name: /Run/ })).toBeVisible();
    await expect(page.getByText("State")).toBeVisible();
    await expect(page.getByText("Started")).toBeVisible();
    await expect(page.getByText("Logs")).toBeVisible();

    // The page should NOT have crashed — verify by checking the page is still interactive
    await expect(page.getByRole("button", { name: "Back to runs" })).toBeVisible();
  });

  test("run detail shows log entries without crashing", async ({ login, page }) => {
    await login();

    // Create a chat (triggers a run automatically)
    await page.getByLabel("Message").first().fill("Run logs test");
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByRole("heading", { name: /Chat:/ })).toBeVisible();
    await page.waitForTimeout(2000);

    // Navigate to run detail
    await page.getByRole("navigation").getByRole("button", { name: "Runs" }).click();
    await expect(page.locator("table tbody tr").first()).toBeVisible({ timeout: 5000 });
    await page.locator("table tbody tr").first().getByRole("link").first().click();

    // Should show the logs section without errors
    await expect(page.getByText("Logs")).toBeVisible();
  });

  test("back to runs button works from run detail", async ({ login, page }) => {
    await login();

    // Create a chat (triggers a run automatically)
    await page.getByLabel("Message").first().fill("Back nav test");
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByRole("heading", { name: /Chat:/ })).toBeVisible();
    await page.waitForTimeout(2000);

    // Go to runs and click into detail
    await page.getByRole("navigation").getByRole("button", { name: "Runs" }).click();
    await expect(page.locator("table tbody tr").first()).toBeVisible({ timeout: 5000 });
    await page.locator("table tbody tr").first().getByRole("link").first().click();
    await expect(page.getByRole("heading", { name: /Run/ })).toBeVisible();

    // Click back
    await page.getByRole("button", { name: "Back to runs" }).click();
    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/runs");
  });
});
