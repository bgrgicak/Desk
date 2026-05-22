/**
 * Library live-reload — when an external process (e.g. an agent) updates a
 * library file via the API, the file preview must refresh automatically in
 * the browser without the user reloading the page.
 *
 * Pipeline under test:
 *   PUT /library/content → server → WS broadcast `library.changed`
 *   → client middleware → derivedSlice.bumpFileChangeCounter
 *   → ContextDetail useEffect re-runs → fetchLibraryContent → editor updates
 */
import { test, expect } from "../fixtures";

async function uploadText(
  serverUrl: string,
  token: string,
  workspaceId: string,
  name: string,
  body: string,
): Promise<string> {
  const boundary = `----roomy-e2e-${Math.random().toString(16).slice(2)}`;
  const buf = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        `Content-Type: application/json\r\n\r\n`,
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
  const json = await res.json() as { path: string };
  return json.path;
}

async function putContent(
  serverUrl: string,
  token: string,
  workspaceId: string,
  filePath: string,
  newContent: string,
): Promise<void> {
  const res = await fetch(
    `${serverUrl}/library/content?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(filePath)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: newContent,
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
  // Wait until the detail pane is open (the more-actions menu is always
  // rendered for open items; the save button is only shown when dirty).
  await expect(page.getByTestId("library-detail-more")).toBeVisible({ timeout: 10_000 });
}

test("file preview updates automatically when content is changed via the API", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;
  const workspaceId = ws[0].id;

  const filename = `live-reload-${Date.now()}.json`;
  const initial = "initial content\n";
  const updated = `updated by agent at ${Date.now()}\n`;

  const filePath = await uploadText(serverUrl, token, workspaceId, filename, initial);

  // Open the file in the browser — this starts the WS connection and loads
  // the initial content into the CodeMirror editor.
  await openLibraryFile(loggedInPage, filename);

  // Verify the initial content is visible before mutating.
  await expect(loggedInPage.locator(".cm-content")).toContainText("initial content");

  // Simulate an agent rewriting the file via the API.
  // The server will broadcast `library.changed` to all WS clients.
  await putContent(serverUrl, token, workspaceId, filePath, updated);

  // The browser's WS middleware receives `library.changed`, bumps the
  // fileChangeCounter in Redux, which re-triggers the fetch effect in
  // ContextDetail. Poll until the new content appears — no page reload,
  // no user interaction.
  await expect.poll(
    () => loggedInPage.locator(".cm-content").textContent(),
    { timeout: 10_000, message: "editor should auto-refresh after WS library.changed event" },
  ).toContain(updated.trim());
});

test("unsaved local edits are preserved when the server updates the file", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;
  const workspaceId = ws[0].id;

  const filename = `live-reload-dirty-${Date.now()}.json`;
  const initial = "base content\n";
  const agentUpdate = `server update at ${Date.now()}\n`;

  const filePath = await uploadText(serverUrl, token, workspaceId, filename, initial);
  await openLibraryFile(loggedInPage, filename);
  await expect(loggedInPage.locator(".cm-content")).toContainText("base content");

  // Type something to make the editor dirty *before* the server update.
  const localEdit = `local-edit-${Date.now()}`;
  const editor = loggedInPage.locator(".cm-content").first();
  await editor.click();
  await loggedInPage.keyboard.press("ControlOrMeta+End");
  await loggedInPage.keyboard.type(localEdit);

  // Confirm editor is dirty — save button is enabled.
  const saveBtn = loggedInPage.getByTestId("library-save");
  await expect(saveBtn).toHaveAttribute("data-save-state", "dirty");

  // Agent updates the file on the server.
  await putContent(serverUrl, token, workspaceId, filePath, agentUpdate);

  // Give the WS event time to arrive and be processed.
  await loggedInPage.waitForTimeout(2_000);

  // The local edit must still be present — the background refresh must
  // NOT overwrite unsaved local changes.
  await expect(loggedInPage.locator(".cm-content")).toContainText(localEdit);

  // The save button must still show dirty (not saved, not idle).
  await expect(saveBtn).toHaveAttribute("data-save-state", "dirty");
});
