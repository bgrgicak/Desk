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

  // Open Customize → Preferences.
  await loggedInPage.getByRole("button", { name: /Customize/ }).click();
  let dialog = loggedInPage.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Preferences$/ }).click();

  // The "auto-save" switch defaults to checked. Toggle it OFF and
  // pick a non-default view ("chats").
  const autoSave = dialog.getByTestId("prefs-auto-save");
  await expect(autoSave).toHaveAttribute("data-state", "checked");
  await autoSave.click();
  await expect(autoSave).toHaveAttribute("data-state", "unchecked");

  await dialog.getByTestId("prefs-default-view-chats").click();

  // Reload, re-open Customize → Preferences. The values must stick.
  await loggedInPage.reload();
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible();
  await loggedInPage.getByRole("button", { name: /Customize/ }).click();
  dialog = loggedInPage.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Preferences$/ }).click();

  await expect(dialog.getByTestId("prefs-auto-save")).toHaveAttribute("data-state", "unchecked");
  // The selected view button has the active styling — assert via its
  // class containing the active-state classes.
  const chatsButton = dialog.getByTestId("prefs-default-view-chats");
  await expect(chatsButton).toHaveClass(/bg-foreground/);

  // The persisted blob lives at desk.prefs.<userId>; assert the shape.
  const stored = await loggedInPage.evaluate(() => {
    const keys = Object.keys(localStorage).filter(k => k.startsWith("desk.prefs."));
    if (keys.length !== 1) return null;
    return localStorage.getItem(keys[0]);
  });
  expect(stored).not.toBeNull();
  const parsed = JSON.parse(stored!) as { autoSave: boolean; defaultView: string };
  expect(parsed.autoSave).toBe(false);
  expect(parsed.defaultView).toBe("chats");
});
