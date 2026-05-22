/**
 * Slice 2 — workspaces.
 *
 * GET /workspaces is fetched on boot. The seeded user has a single
 * workspace named "Roomy", so its name appears as the active room
 * breadcrumb link in the top bar (the old hover-revealed workspace tab
 * bar + "+" trigger were removed in favour of the Home picker).
 */
import { test, expect } from "../fixtures";

test("seeded workspace is visible in the breadcrumb", async ({ loggedInPage }) => {
  // "Roomy" is the seeded workspace name (see packages/server/db/src/seed.ts).
  await expect(loggedInPage.getByRole("link", { name: /Roomy/ }).first()).toBeVisible();
});

test("editing workspace name + description + color from the Settings modal persists", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  // Reset workspace to seed state so retries start clean. A previous attempt
  // may have renamed it to "Updated Roomy" before failing on a later assertion.
  const listRes = await fetch(`${serverUrl}/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const [ws] = (await listRes.json()) as Array<{ id: string; name: string }>;
  if (ws.name !== "Roomy") {
    await fetch(`${serverUrl}/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Roomy", icon: "", color: "", description: "" }),
    });
    await loggedInPage.reload();
  }

  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible();
  await expect(loggedInPage.getByRole("link", { name: /Roomy/ }).first()).toBeVisible();

  // Open the settings modal.
  await loggedInPage.getByRole("button", { name: /Customize/ }).click();

  // The Workspace section is active by default — it shows the name + description
  // inputs and the accent palette (emoji picker was removed in the redesign).
  const nameInput = loggedInPage.getByPlaceholder("e.g. Marketing");
  await expect(nameInput).toBeVisible();
  await expect(nameInput).toHaveValue("Roomy");

  await nameInput.fill("Updated Roomy");
  await loggedInPage.getByPlaceholder("What this room is for…").fill("new description");
  // Pick a non-default accent — "Pink" in the ROOM_PALETTE labels.
  await loggedInPage.getByRole("button", { name: "Pink", exact: true }).click();

  await loggedInPage.getByRole("button", { name: /Save changes/ }).click();

  // Breadcrumb re-renders with the new name once the mutation invalidates the list.
  await expect(
    loggedInPage.getByRole("link", { name: /Updated Roomy/ }).first(),
  ).toBeVisible({ timeout: 5_000 });

  // Confirm the server actually stored it.
  const res = await fetch(`${serverUrl}/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const list = (await res.json()) as Array<{
    name: string;
    description: string;
    color: string;
  }>;
  expect(list[0]).toMatchObject({
    name: "Updated Roomy",
    description: "new description",
  });
  expect(list[0].color).toBeTruthy();

  // Reload and confirm the change sticks through a fresh boot.
  await loggedInPage.reload();
  await expect(
    loggedInPage.getByRole("link", { name: /Updated Roomy/ }).first(),
  ).toBeVisible({ timeout: 10_000 });
});
