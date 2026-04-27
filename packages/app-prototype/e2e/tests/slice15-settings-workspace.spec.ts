/**
 * Slice 15 — Settings → Workspace tab edits persist through PATCH
 * /workspaces/:id and survive a reload.
 *
 * Covers a different surface than slice02's "Customize" flow: the
 * dedicated Workspace tab inside the SettingsModal (trunk's redesign
 * exposes both entry points).
 */
import { test, expect } from "../fixtures";

test("editing workspace name + icon + color from Settings → Workspace persists", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible();

  await loggedInPage.getByRole("button", { name: /Customize/ }).click();
  // Workspace tab is the default. Confirm and edit.
  const dialog = loggedInPage.getByRole("dialog");
  await expect(dialog.getByPlaceholder("Workspace name")).toBeVisible();

  await dialog.getByPlaceholder("Workspace name").fill("Slice15 Renamed");
  await dialog.getByPlaceholder("What's this workspace for?").fill("renamed by slice15");
  await dialog.getByRole("button", { name: "🚀" }).click();
  await dialog.getByRole("button", { name: "Teal", exact: true }).click();
  await dialog.getByRole("button", { name: /Save changes/ }).click();

  // Re-render reflects the new name.
  await expect(
    loggedInPage.getByRole("button", { name: /Slice15 Renamed/ }).first(),
  ).toBeVisible({ timeout: 5_000 });

  // Server actually stored the values.
  const res = await fetch(`${serverUrl}/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const list = (await res.json()) as Array<{
    name: string; icon: string; color: string; description: string;
  }>;
  const updated = list.find(w => w.name === "Slice15 Renamed");
  expect(updated).toBeDefined();
  expect(updated).toMatchObject({ icon: "🚀", color: "#ccfbf1", description: "renamed by slice15" });

  // Reload — values stick.
  await loggedInPage.reload();
  await expect(
    loggedInPage.getByRole("button", { name: /Slice15 Renamed/ }).first(),
  ).toBeVisible({ timeout: 10_000 });
});
