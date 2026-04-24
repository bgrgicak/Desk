/**
 * Slice 2 — workspaces.
 *
 * GET /workspaces is fetched on boot. The seeded user has a single
 * workspace named "Desk", so its tab must be visible in the top bar.
 */
import { test, expect } from "../fixtures";

test("seeded workspace is visible in the bar", async ({ loggedInPage }) => {
  // "Desk" is the seeded workspace name (see packages/server/db/src/seed.ts).
  await expect(loggedInPage.getByRole("button", { name: /Desk/ }).first()).toBeVisible();
});

test("editing workspace name + description from the Customize modal persists", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  // Seeded workspace is "Desk" (see packages/server/db/src/seed.ts).
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible();
  await expect(loggedInPage.getByRole("button", { name: /Desk/ }).first()).toBeVisible();

  // Open the settings modal.
  await loggedInPage.getByRole("button", { name: /Customize/ }).click();

  // The Workspace section is active by default — it shows the name input and the icon grid.
  const nameInput = loggedInPage.getByPlaceholder("Workspace name");
  await expect(nameInput).toBeVisible();
  await expect(nameInput).toHaveValue("Desk");

  await nameInput.fill("Updated Desk");
  await loggedInPage.getByPlaceholder("What's this workspace for?").fill("new description");
  // Pick a non-default emoji so we also verify icon roundtrip.
  await loggedInPage.getByRole("button", { name: "🚀" }).click();

  await loggedInPage.getByRole("button", { name: /Save changes/ }).click();

  // Bar re-renders with the new name after the mutation invalidates the list.
  await expect(
    loggedInPage.getByRole("button", { name: /Updated Desk/ }).first(),
  ).toBeVisible({ timeout: 5_000 });

  // Confirm the server actually stored it.
  const res = await fetch(`${serverUrl}/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const list = (await res.json()) as Array<{
    name: string;
    description: string;
    icon: string;
  }>;
  expect(list[0]).toMatchObject({
    name: "Updated Desk",
    description: "new description",
    icon: "🚀",
  });

  // Reload and confirm the change sticks through a fresh boot.
  await loggedInPage.reload();
  await expect(
    loggedInPage.getByRole("button", { name: /Updated Desk/ }).first(),
  ).toBeVisible({ timeout: 10_000 });
});

test("creating a workspace adds it to the bar on reload", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  // Wait for the app to be fully rendered first (the seeded workspace
  // acts as a readiness signal).
  await expect(
    loggedInPage.getByTestId("account-avatar"),
  ).toBeVisible();

  // Create a workspace via the API directly — exercises the GET list
  // refreshing without relying on the Create modal flow.
  const res = await fetch(`${serverUrl}/workspaces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      name: "Slice2 Scratch",
      description: "created by slice02 spec",
      icon: "🧪",
    }),
  });
  expect(res.status).toBe(201);

  // Force a reload — the app doesn't have WS push yet (that's slice 12).
  await loggedInPage.reload();
  await expect(
    loggedInPage.getByRole("button", { name: /Slice2 Scratch/ }).first(),
  ).toBeVisible({ timeout: 10_000 });
});
