import { test, expect } from "../fixtures";

test.describe("Workspace", () => {
  test("shows workspace page with form", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Workspace" }).click();
    await expect(page.getByRole("heading", { name: /Workspace:/ })).toBeVisible();
    await expect(page.getByLabel("Name")).toBeVisible();
  });

  test("update workspace name and description", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Workspace" }).click();
    await expect(page.getByRole("heading", { name: /Workspace:/ })).toBeVisible();

    await page.getByLabel("Name").fill("Updated Workspace");
    await page.getByLabel("Description").fill("A test workspace");
    await page.getByRole("button", { name: "Save workspace" }).click();

    await expect(page.getByRole("heading", { name: /Workspace: Updated Workspace/ })).toBeVisible();
  });

  test("update workspace icon", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Workspace" }).click();

    await page.getByLabel("Icon").fill("star");
    await page.getByRole("button", { name: "Save workspace" }).click();

    await expect(page.getByRole("heading", { name: /Workspace:/ })).toBeVisible();
  });

  test("delete workspace button is present", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Workspace" }).click();
    await expect(page.getByRole("heading", { name: /Workspace:/ })).toBeVisible();
    // Verify the delete button exists (don't click — would destroy shared state)
    await expect(page.getByRole("button", { name: "Delete workspace" })).toBeVisible();
  });
});
