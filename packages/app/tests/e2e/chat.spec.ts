import { test, expect } from "../fixtures";

test.describe("Chat", () => {
  test("send a message and see it in the list", async ({ login, page }) => {
    await login();
    await page.getByLabel("New chat title").fill("Chat msg test");
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByRole("heading", { name: /Chat: Chat msg test/ })).toBeVisible();

    await page.getByLabel("Message").fill("Hello world");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByRole("listitem").filter({ hasText: "Hello world" })).toBeVisible({ timeout: 5000 });
  });

  test("edit chat title and goal", async ({ login, page }) => {
    await login();
    await page.getByLabel("New chat title").fill("Edit me");
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByRole("heading", { name: /Chat: Edit me/ })).toBeVisible();

    await page.getByRole("button", { name: "Edit chat" }).click();
    await page.getByLabel("Title").fill("Edited title");
    await page.getByLabel("Goal").fill("My goal");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByRole("heading", { name: /Chat: Edited title/ })).toBeVisible();
    await expect(page.getByText("Goal: My goal")).toBeVisible();
  });

  test("upload an artifact to a chat", async ({ login, page }) => {
    await login();
    await page.getByLabel("New chat title").fill("Artifact chat");
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByRole("heading", { name: /Chat: Artifact chat/ })).toBeVisible();

    const buffer = Buffer.from("test file content");
    await page.getByLabel("Choose artifact").setInputFiles({
      name: "test.txt",
      mimeType: "text/plain",
      buffer,
    });
    await page.getByRole("button", { name: "Upload artifact" }).click();

    await expect(page.getByText("test.txt")).toBeVisible({ timeout: 5000 });
  });

  test("smoke: send message and see fake agent response", async ({ login, page }) => {
    await login();
    await page.getByLabel("New chat title").fill("Smoke test chat");
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByRole("heading", { name: /Chat: Smoke test chat/ })).toBeVisible();

    await page.getByLabel("Message").fill("Trigger agent");
    await page.getByRole("button", { name: "Send" }).click();

    // Wait for the user message first
    await expect(
      page.getByRole("listitem").filter({ hasText: "Trigger agent" }),
    ).toBeVisible({ timeout: 5000 });

    // The fake run inserts an "agent" role message with "fake assistant response".
    // The message arrives via WebSocket (message.appended event).
    await expect(
      page.getByRole("listitem").filter({ hasText: "fake assistant response" }),
    ).toBeVisible({ timeout: 15000 });
  });

  test("navigate back to chats list", async ({ login, page }) => {
    await login();
    await page.getByLabel("New chat title").fill("Nav test");
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByRole("heading", { name: /Chat: Nav test/ })).toBeVisible();

    await page.getByRole("button", { name: "Back to chats" }).click();
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  });
});
