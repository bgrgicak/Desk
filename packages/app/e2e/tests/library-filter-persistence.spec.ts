/**
 * Regression: Library type filter (All/Folders/Files/Notes/Links + Hidden)
 * is persisted in localStorage and must survive both folder navigation and
 * a hard refresh. Two prior bugs:
 *
 *   1. `navigateToFolder` reset typeFilter to 'all' on every folder click,
 *      which also overwrote the persisted localStorage value.
 *   2. `usePrefs` returned defaults during the brief window before the
 *      `me` query resolved. A reset effect that watched `developerMode`
 *      saw `false`, treated the persisted 'hidden' value as illegal, and
 *      clobbered it back to 'all' on every page load.
 *
 * The filter is rendered as a dropdown — its trigger
 * (`data-testid="library-type-filter"`) shows the current selection's label.
 * "Active" is therefore expressed as the trigger's text content, not a
 * pill-style class.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

async function pickTypeFilter(page: Page, label: string): Promise<void> {
  await page.getByTestId("library-type-filter").click();
  await page.getByRole("menuitem", { name: new RegExp(`^${label}$`) }).click();
}

async function expectTypeFilter(page: Page, label: string): Promise<void> {
  await expect(page.getByTestId("library-type-filter")).toHaveText(
    new RegExp(label),
  );
}

async function ensureFolder(
  serverUrl: string,
  token: string,
  workspaceId: string,
  path: string,
): Promise<void> {
  await fetch(
    `${serverUrl}/library/folder?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path }),
    },
  );
}

async function uploadLibraryFile(
  serverUrl: string,
  token: string,
  workspaceId: string,
  name: string,
  body: string,
): Promise<void> {
  const boundary = `----desk-e2e-${Math.random().toString(16).slice(2)}`;
  const bodyBuf = Buffer.concat([
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
        "Content-Length": String(bodyBuf.length),
      },
      body: bodyBuf,
    },
  );
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
}

async function getMyUserId(serverUrl: string, token: string): Promise<string> {
  const res = await fetch(`${serverUrl}/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { id: string };
  return body.id;
}

test("type filter survives folder navigation", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const folder = `FilterPersistNav-${Date.now()}`;
  await ensureFolder(serverUrl, token, ws[0].id, folder);

  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Library$/ }).first().click();

  // Use the Folders filter so the row we want to click stays visible.
  await pickTypeFilter(loggedInPage, "Folders");
  await expectTypeFilter(loggedInPage, "Folders");

  // Click into the folder — typeFilter must NOT reset to 'all'.
  await loggedInPage.getByText(folder, { exact: true }).first().click();
  await expectTypeFilter(loggedInPage, "Folders");
});

test("type filter survives a hard refresh", async ({ loggedInPage }) => {
  await loggedInPage.getByRole("link", { name: /^Library$/ }).first().click();

  await pickTypeFilter(loggedInPage, "Files");
  await expectTypeFilter(loggedInPage, "Files");

  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Library$/ }).first().click();
  await expectTypeFilter(loggedInPage, "Files");
});

test("Hidden filter survives a hard refresh when developer mode is on", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  // Seed prefs + persisted typeFilter directly. The pref bag is keyed by
  // userId so we have to fetch /me first; an empty bag wouldn't be picked
  // up by usePrefs (it falls back to defaults until userId is known).
  const userId = await getMyUserId(serverUrl, token);
  await loggedInPage.evaluate(({ uid }: { uid: string }) => {
    localStorage.setItem(
      `desk.prefs.${uid}`,
      JSON.stringify({ developerMode: true }),
    );
    localStorage.setItem("desk.context.typeFilter", JSON.stringify("hidden"));
  }, { uid: userId });

  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Library$/ }).first().click();

  // Hidden is dev-only; if developerMode survives, it remains a valid choice.
  // If the persisted typeFilter survives, the trigger displays "Hidden".
  await expectTypeFilter(loggedInPage, "Hidden");

  // A second refresh — the prior bug rewrote 'hidden' → 'all' on every load.
  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Library$/ }).first().click();
  await expectTypeFilter(loggedInPage, "Hidden");
});

test("Hidden filter includes normal and hidden library files", async ({
  loggedInPage,
  serverUrl,
  serverHome,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string; path: string }>;
  const userId = await getMyUserId(serverUrl, token);
  const stamp = Date.now();
  const visible = `hidden-filter-visible-${stamp}.md`;
  const hidden = `.hidden-filter-hidden-${stamp}.md`;

  await uploadLibraryFile(serverUrl, token, ws[0].id, visible, "visible\n");
  // The upload API rejects dotfile names by design (`rejectHiddenName`),
  // so write the hidden file directly via the host filesystem to mirror
  // an agent-origin or external-tool drop.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.writeFile(path.join(serverHome, ws[0].path, hidden), "hidden\n", "utf8");

  await loggedInPage.evaluate(({ uid }: { uid: string }) => {
    localStorage.setItem(
      `desk.prefs.${uid}`,
      JSON.stringify({ developerMode: true }),
    );
  }, { uid: userId });

  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Library$/ }).first().click();

  await pickTypeFilter(loggedInPage, "Hidden");
  await expect(loggedInPage.getByText(visible, { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(loggedInPage.getByText(hidden, { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });
});
