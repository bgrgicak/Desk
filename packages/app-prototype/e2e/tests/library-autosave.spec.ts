/**
 * Library auto-save — when the `autoSave` preference is on (default),
 * edits in the library text-file editor must be persisted to the server
 * shortly after the last keystroke. When the preference is off, only an
 * explicit Save button click writes the change.
 *
 * The Save button doubles as a status pill: data-save-state takes the
 * values "idle" | "dirty" | "saving" | "saved" so the test can assert on
 * the transition without racing the visible label.
 */
import { test, expect } from "../fixtures";

const AUTO_SAVE_DEBOUNCE_MS = 1_000;

async function uploadMarkdown(
  serverUrl: string,
  token: string,
  workspaceId: string,
  name: string,
  body: string,
): Promise<void> {
  const boundary = `----desk-e2e-${Math.random().toString(16).slice(2)}`;
  const buf = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        `Content-Type: text/markdown\r\n\r\n`,
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

async function fetchContent(
  serverUrl: string,
  token: string,
  workspaceId: string,
  path: string,
): Promise<string> {
  const res = await fetch(
    `${serverUrl}/library/content?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(res.ok).toBe(true);
  return res.text();
}

async function setAutoSavePref(
  page: import("@playwright/test").Page,
  serverUrl: string,
  token: string,
  value: boolean,
): Promise<void> {
  // The preferences blob is keyed `desk.prefs.<userId>` and is only
  // written when the user actually toggles a switch in the Preferences
  // tab. For a fresh test session there is no key yet, so we derive
  // userId from /me and seed the key ourselves — otherwise the page
  // falls back to PREFS_DEFAULTS (autoSave=true) and the test silently
  // exercises the wrong branch.
  const me = (await (
    await fetch(`${serverUrl}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as { id: string };
  await page.evaluate(
    ({ userId, v }: { userId: string; v: boolean }) => {
      const key = `desk.prefs.${userId}`;
      const cur = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...cur, autoSave: v }));
      window.dispatchEvent(new CustomEvent("desk:prefs-changed"));
    },
    { userId: me.id, v: value },
  );
}

async function openLibraryFile(
  page: import("@playwright/test").Page,
  filename: string,
): Promise<void> {
  await page.reload();
  await expect(page.getByTestId("account-avatar")).toBeVisible();
  await page.getByRole("button", { name: /^Library$/ }).first().click();
  const row = page.getByText(filename).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(page.getByTestId("library-save")).toBeVisible({ timeout: 10_000 });
}

async function typeIntoEditor(
  page: import("@playwright/test").Page,
  text: string,
): Promise<void> {
  // CodeMirror 6 renders a contenteditable at .cm-content. Click into it
  // to focus, jump to the end of the document, then type.
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}

test("auto-save on: edits debounce-save without clicking", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;
  const filename = `autosave-on-${Date.now()}.md`;
  const initial = "# autosave on\n";
  await uploadMarkdown(serverUrl, token, ws[0].id, filename, initial);

  // Default pref is autoSave=true; assert it explicitly so a future
  // default flip doesn't silently neuter this test.
  await setAutoSavePref(loggedInPage, serverUrl, token, true);
  await openLibraryFile(loggedInPage, filename);

  const stamp = `auto-${Date.now()}`;
  await typeIntoEditor(loggedInPage, stamp);

  // Either the button flips through "saving" or lands on "saved".
  const saveBtn = loggedInPage.getByTestId("library-save");
  await expect(saveBtn).toHaveAttribute(
    "data-save-state",
    /saving|saved/,
    { timeout: AUTO_SAVE_DEBOUNCE_MS + 5_000 },
  );

  // Server actually has the new content.
  await expect.poll(
    () => fetchContent(serverUrl, token, ws[0].id, filename),
    { timeout: 10_000 },
  ).toContain(stamp);
});

test("auto-save off: edits stay dirty until Save is clicked", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;
  const filename = `autosave-off-${Date.now()}.md`;
  const initial = "# autosave off\n";
  await uploadMarkdown(serverUrl, token, ws[0].id, filename, initial);

  await setAutoSavePref(loggedInPage, serverUrl, token, false);
  await openLibraryFile(loggedInPage, filename);

  const stamp = `manual-${Date.now()}`;
  await typeIntoEditor(loggedInPage, stamp);

  const saveBtn = loggedInPage.getByTestId("library-save");
  // Wait past the debounce window; with auto-save off, the button must
  // remain in the dirty state and the server must still hold the
  // original body.
  await loggedInPage.waitForTimeout(AUTO_SAVE_DEBOUNCE_MS + 500);
  await expect(saveBtn).toHaveAttribute("data-save-state", "dirty");
  expect(await fetchContent(serverUrl, token, ws[0].id, filename)).toBe(initial);

  await saveBtn.click();
  await expect(saveBtn).toHaveAttribute("data-save-state", /saving|saved|idle/);
  await expect.poll(
    () => fetchContent(serverUrl, token, ws[0].id, filename),
    { timeout: 10_000 },
  ).toContain(stamp);
});
