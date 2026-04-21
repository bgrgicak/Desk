import { test, expect } from "../fixtures";

/**
 * Detailed user-journey e2e: one narrative path that exercises how the
 * features compose.
 *
 * Deliberately does NOT mutate seeded identity state (agent instructions,
 * workspace name, account email) — those are covered by the per-feature
 * specs. The global setup runs one shared DB across all tests, so cross-
 * test mutations show up as flakes in later tests.
 */
test.describe("Full user journey", () => {
  test("end-to-end demo flow", async ({ login, page }) => {
    // 1. Login
    await login();
    await expect(page.getByRole("heading", { name: "Desk" })).toBeVisible();

    // 2. Create a chat from Today
    await page.getByLabel("New chat title").fill("Journey Demo Chat");
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(
      page.getByRole("heading", { name: /Chat: Journey Demo Chat/ }),
    ).toBeVisible();

    // 3. Send a message; user message appears, agent reply follows
    await page.getByLabel("Message").fill("Hello journey!");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByRole("listitem").filter({ hasText: "Hello journey!" }),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByRole("listitem").filter({ hasText: /agent/i }),
    ).toBeVisible({ timeout: 10000 });

    // 4. Upload an artifact to the chat
    await page.getByLabel("Choose artifact").setInputFiles({
      name: "journey.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("journey artifact bytes"),
    });
    await page.getByRole("button", { name: "Upload artifact" }).click();
    await expect(page.getByText("journey.txt")).toBeVisible({ timeout: 5000 });

    // 5. Upload to the library via the library page
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
    await page.getByLabel("Choose file").setInputFiles({
      name: "lib-journey.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("library-journey bytes"),
    });
    await page.getByRole("button", { name: "Upload to library" }).click();
    await expect(page.getByText("lib-journey.txt")).toBeVisible({ timeout: 5000 });

    // 6. Search finds both the chat and the library file
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();
    await page.getByLabel("Query").fill("journey");
    await page.getByRole("button", { name: "Submit search" }).click();
    await expect(page.getByText("Journey Demo Chat")).toBeVisible();
    await expect(page.getByText("lib-journey.txt")).toBeVisible();

    // 7. Runs page renders (per-run content is covered by runs.spec.ts).
    await page.getByRole("button", { name: "Runs", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  });

  test("scheduled job can be created from the UI", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Scheduled", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Scheduled Jobs" })).toBeVisible();

    await page.getByLabel("Mode").selectOption("scheduled");
    await page.getByLabel("Spec").fill("2099-01-01T00:00:00Z");
    await page.getByLabel("Prompt").fill("Journey scheduled prompt");
    await page.getByRole("button", { name: "Create job" }).click();

    await expect(page.getByRole("heading", { name: "Scheduled Jobs" })).toBeVisible();
  });
});
