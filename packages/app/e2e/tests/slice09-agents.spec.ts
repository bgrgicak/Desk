/**
 * Slice 9 — Agents settings tab.
 *
 * Covers:
 *  - List: the seeded agent is visible.
 *  - Create: `+ Add custom agent` calls POST /agents and the row appears.
 *  - Edit:   pencil icon exposes name + model; Save PATCHes.
 *  - Delete: trash icon + confirm popover DELETEs and the row disappears.
 *  - Per-workspace enrollment toggles round-trip through the membership API.
 *
 * The Agents section no longer exposes a hardcoded model list; it queries
 * GET /tools/models. In the e2e lane there is no Docker/opencode, so the
 * picker surfaces an empty-state message instead of a real menu — which is
 * the fallback we want users to see when no provider keys are configured.
 */
import { test, expect } from "../fixtures";

async function openAgentsTab(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /Customize/i }).click();
  await page.getByRole("button", { name: /^Agents$/i }).click();
  // Wait for /tools/models to populate. The Add form snapshots flatModels
  // via useState(initialModel) on mount — open it before models resolve and
  // the Add agent button stays disabled with no way to pick one. The Desk
  // row's provider label is the readiness signal: it only renders once
  // modelIndex has the seeded model.
  await page
    .getByRole("dialog")
    .getByText(/^OpenCode$/)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
}

test("settings modal lists the seeded agent", async ({ loggedInPage }) => {
  await openAgentsTab(loggedInPage);
  await expect(
    loggedInPage.getByRole("dialog").getByText(/^Desk$/).first(),
  ).toBeVisible({ timeout: 10_000 });
});

test("toggling an agent on/off in a workspace round-trips through the membership API", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const uniq = `spec09-acc-${Date.now().toString(36)}`;
  const candidateName = `${uniq}-access`;

  const wsRes = await fetch(`${serverUrl}/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const workspaces = (await wsRes.json()) as Array<{ id: string }>;
  const workspaceId = workspaces[0].id;

  await openAgentsTab(loggedInPage);
  const dialog = loggedInPage.getByRole("dialog");

  // The redesigned Settings modal auto-enrolls a freshly-created agent into
  // the current workspace via addWorkspaceAgent, so the row starts checked.
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByPlaceholder("e.g. Copywriter").fill(candidateName);
  await dialog.getByRole("button", { name: /^Add agent$/i }).click();
  await expect(dialog.getByText(candidateName)).toBeVisible({ timeout: 5_000 });

  const candidateRow = dialog.locator("div.group", { hasText: candidateName }).first();
  const enabledToggle = candidateRow.getByRole("switch", {
    name: new RegExp(`Disable ${candidateName} in this workspace`, "i"),
  });
  await expect(enabledToggle).toBeVisible();
  await expect(enabledToggle).toHaveAttribute("data-state", "checked");

  {
    const memRes = await fetch(
      `${serverUrl}/workspaces/${workspaceId}/agents`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const memberships = (await memRes.json()) as Array<{ name: string }>;
    expect(memberships.find(m => m.name === candidateName)).toBeTruthy();
  }

  // Disable — server gets a DELETE, membership goes away.
  await enabledToggle.click();
  await expect(
    candidateRow.getByRole("switch", {
      name: new RegExp(`Enable ${candidateName} in this workspace`, "i"),
    }),
  ).toHaveAttribute("data-state", "unchecked", { timeout: 5_000 });

  {
    const memRes = await fetch(
      `${serverUrl}/workspaces/${workspaceId}/agents`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const memberships = (await memRes.json()) as Array<{ name: string }>;
    expect(memberships.find(m => m.name === candidateName)).toBeUndefined();
  }

  // Re-enable — server gets a POST, membership comes back.
  await candidateRow
    .getByRole("switch", { name: new RegExp(`Enable ${candidateName} in this workspace`, "i") })
    .click();
  await expect(
    candidateRow.getByRole("switch", {
      name: new RegExp(`Disable ${candidateName} in this workspace`, "i"),
    }),
  ).toHaveAttribute("data-state", "checked", { timeout: 5_000 });

  // Cleanup — remove the custom agent so later tests see the seeded list.
  const agentsRes = await fetch(`${serverUrl}/agents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const allAgents = (await agentsRes.json()) as Array<{ id: string; name: string }>;
  const candidate = allAgents.find(a => a.name === candidateName);
  if (candidate) {
    await fetch(`${serverUrl}/agents/${candidate.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  }
});

test("a freshly-created workspace auto-enrolls the user's first agent", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  // Make sure the app is fully booted before we POST — mirrors slice02.
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible();

  const res = await fetch(`${serverUrl}/workspaces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name: `spec09-auto-${Date.now().toString(36)}` }),
  });
  expect(res.status).toBe(201);
  const ws = (await res.json()) as { id: string };

  const memRes = await fetch(
    `${serverUrl}/workspaces/${ws.id}/agents`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const memberships = (await memRes.json()) as Array<{ name: string }>;
  expect(memberships).toHaveLength(1);

  // Cleanup — the seeded workspace must remain, but we can delete this scratch one.
  await fetch(`${serverUrl}/workspaces/${ws.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
});

test("creating, renaming, and deleting an agent round-trips through the API", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const uniq = `spec09-${Date.now().toString(36)}`;
  const initialName = `${uniq}-initial`;
  const renamedName = `${uniq}-renamed`;

  await openAgentsTab(loggedInPage);
  const dialog = loggedInPage.getByRole("dialog");

  // Open the inline create form.
  await dialog.getByRole("button", { name: "Add", exact: true }).click();

  // Editor uses the default model; no need to touch the picker (which is
  // empty in the e2e lane anyway).
  await dialog.getByPlaceholder("e.g. Copywriter").fill(initialName);
  await dialog.getByRole("button", { name: /^Add agent$/i }).click();

  // New agent row is rendered from the invalidated GET /agents list.
  await expect(dialog.getByText(initialName)).toBeVisible({ timeout: 5_000 });

  // Server row exists; agent-level "instructions" was collapsed into
  // user memory in the memory-system phase 1 PR — we just check the
  // agent landed in the list.
  {
    const res = await fetch(`${serverUrl}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const list = (await res.json()) as Array<{
      id: string;
      name: string;
    }>;
    const created = list.find(a => a.name === initialName);
    expect(created).toBeTruthy();
  }

  // Hover the row to reveal the Edit button, then rename via the Save button
  // in the detail editor.
  const row = dialog.locator("div.group", { hasText: initialName }).first();
  await row.hover();
  await row.getByRole("button", { name: /^Edit$/ }).click();

  const nameInput = dialog.getByPlaceholder("e.g. Copywriter");
  await nameInput.fill(renamedName);
  await dialog.getByRole("button", { name: /^Save$/ }).click();

  await expect(dialog.getByText(renamedName)).toBeVisible({ timeout: 5_000 });
  await expect(dialog.getByText(initialName)).toHaveCount(0);

  // Delete via the row's More actions kebab → Delete (no confirm popover —
  // the redesigned modal deletes immediately from the list).
  const renamedRow = dialog.locator("div.group", { hasText: renamedName }).first();
  await renamedRow.hover();
  await renamedRow.getByRole("button", { name: "More actions" }).click();
  await loggedInPage.getByRole("menuitem", { name: /^Delete$/ }).click();

  await expect(dialog.getByText(renamedName)).toHaveCount(0, { timeout: 5_000 });

  // Server confirms it's gone.
  const res = await fetch(`${serverUrl}/agents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const list = (await res.json()) as Array<{ name: string }>;
  expect(list.find(a => a.name === renamedName)).toBeUndefined();
});
