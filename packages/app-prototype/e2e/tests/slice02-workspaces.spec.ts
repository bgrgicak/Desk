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
