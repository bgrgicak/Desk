import { test, expect } from "../fixtures";

test.describe("Agent", () => {
  test("shows agent page with form", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Agent" }).click();
    await expect(page.getByRole("heading", { name: /Agent:/ })).toBeVisible();
    await expect(page.getByLabel("Name")).toBeVisible();
    await expect(page.getByLabel("Instructions")).toBeVisible();
    await expect(page.getByLabel("Model")).toBeVisible();
  });

  test("update agent name", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Agent" }).click();
    await expect(page.getByRole("heading", { name: /Agent:/ })).toBeVisible();

    await page.getByLabel("Name").fill("Updated Agent Name");
    await page.getByRole("button", { name: "Save agent" }).click();

    // Heading should update
    await expect(page.getByRole("heading", { name: /Agent: Updated Agent Name/ })).toBeVisible();
  });

  test("update agent instructions and model", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Agent" }).click();
    await expect(page.getByRole("heading", { name: /Agent:/ })).toBeVisible();

    await page.getByLabel("Instructions").fill("You are a helpful test agent");
    await page.getByLabel("Model").fill("claude-sonnet-4-6");
    await page.getByRole("button", { name: "Save agent" }).click();

    // Verify no error
    await expect(page.getByRole("heading", { name: /Agent:/ })).toBeVisible();
  });
});
