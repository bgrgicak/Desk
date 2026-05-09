/**
 * Library editor UX — the text editor must feel friendly for non-developer
 * users. This covers:
 *
 *   1. No developer chrome (line numbers, fold gutter) visible when editing
 *      markdown notes.
 *   2. A "Preview" toggle appears for markdown files. Markdown defaults to
 *      preview mode; the last selection is persisted per-file in localStorage.
 */
import { test, expect } from "../fixtures";

async function uploadFile(
  serverUrl: string,
  token: string,
  workspaceId: string,
  name: string,
  body: string,
  contentType: string,
): Promise<void> {
  const boundary = `----desk-e2e-${Math.random().toString(16).slice(2)}`;
  const buf = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    Buffer.from(body, "utf8"),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await fetch(
    `${serverUrl}/library?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(buf.length),
      },
      body: buf,
    },
  );
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
}

async function openLibraryFile(
  page: import("@playwright/test").Page,
  filename: string,
): Promise<void> {
  await page.reload();
  await expect(page.getByTestId("account-avatar")).toBeVisible();
  await page.getByRole("link", { name: /^Library$/ }).first().click();
  const row = page.getByText(filename).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(page.getByTestId("library-detail-more")).toBeVisible({ timeout: 10_000 });
}

test("editor shows no line numbers for markdown files", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const filename = `editor-ux-linenums-${Date.now()}.md`;
  await uploadFile(serverUrl, token, ws[0].id, filename, "# Test\nSome content\n", "text/markdown");
  // Switch to edit mode since markdown defaults to preview
  await openLibraryFile(loggedInPage, filename);
  await loggedInPage.getByTestId("library-preview-toggle").click();

  await expect(loggedInPage.locator(".cm-lineNumbers")).not.toBeVisible();
});

test("preview toggle appears for markdown files", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const filename = `editor-ux-toggle-visible-${Date.now()}.md`;
  await uploadFile(serverUrl, token, ws[0].id, filename, "# Preview Test\n", "text/markdown");
  await openLibraryFile(loggedInPage, filename);

  await expect(loggedInPage.getByTestId("library-preview-toggle")).toBeVisible();
});

test("markdown files open in preview mode by default", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const filename = `editor-ux-default-preview-${Date.now()}.md`;
  await uploadFile(
    serverUrl,
    token,
    ws[0].id,
    filename,
    "# Hello World\nSome **bold** text\n",
    "text/markdown",
  );
  await openLibraryFile(loggedInPage, filename);

  await expect(loggedInPage.locator("h1")).toContainText("Hello World");
  await expect(loggedInPage.locator(".cm-content")).not.toBeVisible();
});

test("preview toggle switches to edit mode", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const filename = `editor-ux-to-edit-${Date.now()}.md`;
  await uploadFile(serverUrl, token, ws[0].id, filename, "# Switch to Edit\n", "text/markdown");
  await openLibraryFile(loggedInPage, filename);

  // Default is preview — one click goes to edit
  await loggedInPage.getByTestId("library-preview-toggle").click();
  await expect(loggedInPage.locator(".cm-content")).toBeVisible();
});

test("preview mode selection persists across reloads", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const filename = `editor-ux-persist-${Date.now()}.md`;
  await uploadFile(serverUrl, token, ws[0].id, filename, "# Persist Test\n", "text/markdown");

  // First open: defaults to preview, switch to edit
  await openLibraryFile(loggedInPage, filename);
  await loggedInPage.getByTestId("library-preview-toggle").click();
  await expect(loggedInPage.locator(".cm-content")).toBeVisible();

  // Reload and re-open: should still be in edit mode
  await openLibraryFile(loggedInPage, filename);
  await expect(loggedInPage.locator(".cm-content")).toBeVisible();
  await expect(loggedInPage.locator("h1")).not.toBeVisible();
});

test("preview toggle does not appear for plain text files", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const filename = `editor-ux-txt-${Date.now()}.txt`;
  await uploadFile(serverUrl, token, ws[0].id, filename, "plain text content\n", "text/plain");
  await openLibraryFile(loggedInPage, filename);

  await expect(loggedInPage.getByTestId("library-preview-toggle")).not.toBeVisible();
});

test("preview toggle appears for html files", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const filename = `editor-ux-html-toggle-${Date.now()}.html`;
  await uploadFile(
    serverUrl,
    token,
    ws[0].id,
    filename,
    "<h1>Hello HTML</h1>\n",
    "text/html",
  );
  await openLibraryFile(loggedInPage, filename);

  await expect(loggedInPage.getByTestId("library-preview-toggle")).toBeVisible();
});

test("html files open in preview mode by default", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const filename = `editor-ux-html-default-${Date.now()}.html`;
  await uploadFile(
    serverUrl,
    token,
    ws[0].id,
    filename,
    "<h1>Hello HTML Preview</h1>\n",
    "text/html",
  );
  await openLibraryFile(loggedInPage, filename);

  await expect(loggedInPage.locator("iframe")).toBeVisible();
  await expect(loggedInPage.locator(".cm-content")).not.toBeVisible();
});

test("html preview toggle switches to edit mode", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const filename = `editor-ux-html-to-edit-${Date.now()}.html`;
  await uploadFile(
    serverUrl,
    token,
    ws[0].id,
    filename,
    "<h1>Switch to Edit</h1>\n",
    "text/html",
  );
  await openLibraryFile(loggedInPage, filename);

  // Default is preview — one click goes to edit
  await loggedInPage.getByTestId("library-preview-toggle").click();
  await expect(loggedInPage.locator(".cm-content")).toBeVisible();
  await expect(loggedInPage.locator("iframe")).not.toBeVisible();
});
