/**
 * Slice 23 — Settings → Preferences persists to localStorage,
 * keyed by user id.
 *
 * Phase-2 wiring: there's no `/me/preferences` route yet, so the
 * Preferences tab persists locally. Toggling a switch and reloading
 * must restore the toggled value (not the default).
 */
import { test, expect } from "../fixtures";

test("preferences toggle persists across reload", async ({ loggedInPage }) => {
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible();

  // Open Settings → Preferences.
  await loggedInPage.getByRole("button", { name: /Settings/ }).click();
  let dialog = loggedInPage.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Preferences$/ }).click();

  // With no saved preference yet, New chat is the selected default.
  await expect(dialog.getByTestId("prefs-default-view-new-chat")).toHaveClass(/bg-foreground/);

  // Pick a non-default view ("tasks") to verify persistence.
  await dialog.getByTestId("prefs-default-view-tasks").click();

  // Reload and verify the value persisted. The Settings modal lives in
  // the URL query string now (`?settings=preferences`), so after reload
  // the dialog re-opens on Preferences automatically — no need to click
  // Settings again. Just wait for the dialog to render.
  await loggedInPage.reload();
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible();
  dialog = loggedInPage.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // The selected view button has the active styling — assert via its
  // class containing the active-state classes.
  const tasksButton = dialog.getByTestId("prefs-default-view-tasks");
  await expect(tasksButton).toHaveClass(/bg-foreground/);

  // The persisted blob lives at roomy.prefs.<userId>; assert the shape.
  const stored = await loggedInPage.evaluate(() => {
    const keys = Object.keys(localStorage).filter(k => k.startsWith("roomy.prefs."));
    if (keys.length !== 1) return null;
    return localStorage.getItem(keys[0]);
  });
  expect(stored).not.toBeNull();
  const parsed = JSON.parse(stored!) as { defaultView: string };
  expect(parsed.defaultView).toBe("tasks");
});
