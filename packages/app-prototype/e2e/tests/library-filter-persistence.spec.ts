/**
 * Regression: Library filter chips (All/Folders/Files/Notes/Links + Hidden)
 * are persisted in localStorage and must survive both folder navigation and
 * a hard refresh. Two prior bugs:
 *
 *   1. `navigateToFolder` reset typeFilter to 'all' on every folder click,
 *      which also overwrote the persisted localStorage value.
 *   2. `usePrefs` returned defaults during the brief window before the
 *      `me` query resolved. A reset effect that watched `developerMode`
 *      saw `false`, treated the persisted 'hidden' value as illegal, and
 *      clobbered it back to 'all' on every page load.
 */
import { test, expect } from "../fixtures";

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
  await loggedInPage.getByRole("button", { name: /^Library$/ }).first().click();

  // Use the Folders filter so the row we want to click stays visible.
  await loggedInPage.getByRole("button", { name: /^Folders$/ }).click();
  await expect(
    loggedInPage.getByRole("button", { name: /^Folders$/ }),
  ).toHaveClass(/bg-muted/);

  // Click into the folder — typeFilter must NOT reset to 'all'.
  await loggedInPage.getByText(folder, { exact: true }).first().click();
  await expect(
    loggedInPage.getByRole("button", { name: /^Folders$/ }),
  ).toHaveClass(/bg-muted/);
});

test("type filter survives a hard refresh", async ({ loggedInPage }) => {
  await loggedInPage.getByRole("button", { name: /^Library$/ }).first().click();

  await loggedInPage.getByRole("button", { name: /^Files$/ }).click();
  await expect(
    loggedInPage.getByRole("button", { name: /^Files$/ }),
  ).toHaveClass(/bg-muted/);

  await loggedInPage.reload();
  await expect(
    loggedInPage.getByRole("button", { name: /^Files$/ }),
  ).toHaveClass(/bg-muted/);
});

test("Hidden chip survives a hard refresh when developer mode is on", async ({
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
  await loggedInPage.getByRole("button", { name: /^Library$/ }).first().click();

  // Hidden chip is dev-only; if developerMode survives, it renders. If the
  // persisted typeFilter survives, it's the active one.
  await expect(
    loggedInPage.getByRole("button", { name: /^Hidden$/ }),
  ).toHaveClass(/bg-muted/);

  // A second refresh — the prior bug rewrote 'hidden' → 'all' on every load.
  await loggedInPage.reload();
  await loggedInPage.getByRole("button", { name: /^Library$/ }).first().click();
  await expect(
    loggedInPage.getByRole("button", { name: /^Hidden$/ }),
  ).toHaveClass(/bg-muted/);
});
