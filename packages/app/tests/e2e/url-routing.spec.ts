import { test, expect } from "../fixtures";

test.describe("URL routing", () => {
  test("navigating to a page updates the URL", async ({ login, page }) => {
    await login();
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");

    // Use pages that don't trigger heavy data fetches
    await page.getByRole("navigation").getByRole("button", { name: "Agent" }).click();
    await expect(page.getByRole("heading", { name: /Agent/ })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/agent");

    await page.getByRole("navigation").getByRole("button", { name: "Workspace" }).click();
    await expect(page.getByRole("heading", { name: /Workspace/ })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/workspace");

    await page.getByRole("navigation").getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/search");
  });

  test("browser back button navigates to previous page", async ({ login, page }) => {
    await login();
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();

    await page.getByRole("navigation").getByRole("button", { name: "Agent" }).click();
    await expect(page.getByRole("heading", { name: /Agent/ })).toBeVisible();

    await page.getByRole("navigation").getByRole("button", { name: "Workspace" }).click();
    await expect(page.getByRole("heading", { name: /Workspace/ })).toBeVisible();

    // Go back
    await page.goBack();
    await expect(page.getByRole("heading", { name: /Agent/ })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/agent");

    // Go back again to Today
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("creating a chat updates URL to /chat/:id", async ({ login, page }) => {
    await login();
    await page.getByLabel("Message").first().fill("URL routing chat");
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByRole("heading", { name: /Chat:/ })).toBeVisible();

    const pathname = new URL(page.url()).pathname;
    expect(pathname).toMatch(/^\/chat\/.+/);
  });

  // Run detail URL is verified by run-detail.spec.ts which reliably
  // creates and navigates to runs. This avoids flaky timing issues
  // when runs from previous tests saturate the shared DB.
});
