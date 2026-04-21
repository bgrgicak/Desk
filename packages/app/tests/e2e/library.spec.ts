import { test, expect } from "../fixtures";

test.describe("Library", () => {
  test("shows library page", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Library" }).click();
    await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  });

  test("upload a file to library", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Library" }).click();

    const buffer = Buffer.from("library file content");
    await page.getByLabel("Choose file").setInputFiles({
      name: "doc.txt",
      mimeType: "text/plain",
      buffer,
    });
    await page.getByRole("button", { name: "Upload to library" }).click();

    await expect(page.getByText("doc.txt")).toBeVisible({ timeout: 5000 });
  });

  test("switch between list and grid views", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Library" }).click();

    // Upload a file first so we can see the views
    const buffer = Buffer.from("view test");
    await page.getByLabel("Choose file").setInputFiles({
      name: "viewtest.txt",
      mimeType: "text/plain",
      buffer,
    });
    await page.getByRole("button", { name: "Upload to library" }).click();
    await expect(page.getByText("viewtest.txt")).toBeVisible({ timeout: 5000 });

    // Default is list view (table within main)
    await expect(page.getByRole("main").getByRole("table")).toBeVisible();

    // Switch to grid view
    await page.getByRole("button", { name: /Switch to grid/ }).click();
    // In grid view the table is gone and a list appears
    await expect(page.getByRole("button", { name: /Switch to list/ })).toBeVisible();

    // Switch back to list view
    await page.getByRole("button", { name: /Switch to list/ }).click();
    await expect(page.getByRole("main").getByRole("table")).toBeVisible();
  });

  test("navigate to library item detail", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Library" }).click();

    const buffer = Buffer.from("detail test");
    await page.getByLabel("Choose file").setInputFiles({
      name: "detail.txt",
      mimeType: "text/plain",
      buffer,
    });
    await page.getByRole("button", { name: "Upload to library" }).click();
    await expect(page.getByText("detail.txt")).toBeVisible({ timeout: 5000 });

    await page.getByRole("link", { name: "detail.txt" }).click();
    await expect(page.getByRole("heading", { name: /Library: detail.txt/ })).toBeVisible();
  });

  test("add a note to a library item", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Library" }).click();

    const buffer = Buffer.from("note test");
    await page.getByLabel("Choose file").setInputFiles({
      name: "noted.txt",
      mimeType: "text/plain",
      buffer,
    });
    await page.getByRole("button", { name: "Upload to library" }).click();
    await expect(page.getByText("noted.txt")).toBeVisible({ timeout: 5000 });

    await page.getByRole("link", { name: "noted.txt" }).click();
    await expect(page.getByRole("heading", { name: /Library: noted.txt/ })).toBeVisible();

    await page.getByLabel("Note").fill("This is a note");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByRole("heading", { name: /Library: noted.txt/ })).toBeVisible();
  });

  test("delete a library item", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Library" }).click();

    const buffer = Buffer.from("delete me");
    await page.getByLabel("Choose file").setInputFiles({
      name: "deletable.txt",
      mimeType: "text/plain",
      buffer,
    });
    await page.getByRole("button", { name: "Upload to library" }).click();
    await expect(page.getByText("deletable.txt")).toBeVisible({ timeout: 5000 });

    await page.getByRole("link", { name: "deletable.txt" }).click();
    await expect(page.getByRole("heading", { name: /Library: deletable.txt/ })).toBeVisible();

    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  });

  test("download a library item", async ({ login, page }) => {
    await login();
    await page.getByRole("button", { name: "Library" }).click();

    const buffer = Buffer.from("download content");
    await page.getByLabel("Choose file").setInputFiles({
      name: "downloadable.txt",
      mimeType: "text/plain",
      buffer,
    });
    await page.getByRole("button", { name: "Upload to library" }).click();
    await expect(page.getByText("downloadable.txt")).toBeVisible({ timeout: 5000 });

    await page.getByRole("link", { name: "downloadable.txt" }).click();
    await expect(page.getByRole("heading", { name: /Library: downloadable.txt/ })).toBeVisible();

    await page.getByRole("button", { name: "Download" }).click();
    await expect(page.getByRole("heading", { name: /Library: downloadable.txt/ })).toBeVisible();
  });
});
