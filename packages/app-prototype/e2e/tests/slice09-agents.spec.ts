/**
 * Slice 9 — Agents tab in SettingsModal shows real agents from GET /agents.
 */
import { test, expect } from "../fixtures";

test("settings modal lists the seeded agent", async ({ loggedInPage }) => {
  // Open the sidebar's Customize button.
  await loggedInPage.getByRole("button", { name: /Customize/i }).click();

  // Open Agents tab.
  await loggedInPage.getByRole("button", { name: /^Agents$/i }).click();

  // Seeded agent is named "Desk".
  await expect(
    loggedInPage.getByRole("dialog").getByText(/^Desk$/).first(),
  ).toBeVisible({ timeout: 10_000 });
});
