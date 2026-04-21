import { test, expect } from "../fixtures";

test("shows empty chats list after login", async ({ login, page }) => {
  await login();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
});

test("create a new chat and navigate to it", async ({ login, page }) => {
  await login();
  await page.getByLabel("New chat title").fill("My test chat");
  await page.getByRole("button", { name: "New chat" }).click();
  // Should navigate to chat detail
  await expect(page.getByRole("heading", { name: /Chat: My test chat/ })).toBeVisible();
});
