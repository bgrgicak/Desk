/**
 * Slice 9 — Agents settings tab.
 *
 * Covers:
 *  - List: the seeded agent is visible.
 *  - Create: `+ Add custom agent` calls POST /agents and the row appears.
 *  - Edit:   pencil icon exposes name + instructions + model; Save PATCHes.
 *  - Delete: trash icon + confirm popover DELETEs and the row disappears.
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
}

test("settings modal lists the seeded agent", async ({ loggedInPage }) => {
  await openAgentsTab(loggedInPage);
  await expect(
    loggedInPage.getByRole("dialog").getByText(/^Desk$/).first(),
  ).toBeVisible({ timeout: 10_000 });
});

test("clicking the star promotes an agent to this workspace's default", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const uniq = `spec09-def-${Date.now().toString(36)}`;
  const candidateName = `${uniq}-candidate`;

  // Discover the seeded workspace id via the API (server-shared e2e fixture).
  const wsRes = await fetch(`${serverUrl}/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const workspaces = (await wsRes.json()) as Array<{ id: string }>;
  const workspaceId = workspaces[0].id;

  await openAgentsTab(loggedInPage);
  const dialog = loggedInPage.getByRole("dialog");

  // Create a second agent so we have a non-default to promote.
  await dialog.getByRole("button", { name: /Add custom agent/i }).click();
  await dialog.getByLabel("Agent name").fill(candidateName);
  await dialog.getByRole("button", { name: /^Create agent$/i }).click();
  await expect(dialog.getByText(candidateName)).toBeVisible({ timeout: 5_000 });

  // The candidate row's star starts unfilled ("Make ... the default agent ...").
  const candidateRow = dialog.locator("div.group", { hasText: candidateName }).first();
  const makeDefaultBtn = candidateRow.getByRole("button", {
    name: new RegExp(`Make ${candidateName} the default agent`, "i"),
  });
  await expect(makeDefaultBtn).toBeVisible();

  await makeDefaultBtn.click();

  // UI reflects the new default via the "Default" badge and the pressed star.
  await expect(
    candidateRow.getByText("Default", { exact: false }),
  ).toBeVisible({ timeout: 5_000 });
  await expect(
    candidateRow.getByRole("button", {
      name: new RegExp(`${candidateName} is the default agent`, "i"),
    }),
  ).toBeVisible();

  // Server-side: /workspaces/:id/agents returns exactly one isDefault row,
  // and it's our candidate.
  const memRes = await fetch(
    `${serverUrl}/workspaces/${workspaceId}/agents`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const memberships = (await memRes.json()) as Array<{
    id: string;
    name: string;
    isDefault: boolean;
  }>;
  const defaults = memberships.filter(m => m.isDefault);
  expect(defaults).toHaveLength(1);
  expect(defaults[0].name).toBe(candidateName);

  // Cleanup — restore the seeded "Desk" agent as default so later tests
  // (and the shared fixture) aren't affected.
  const desk = memberships.find(m => m.name === "Desk");
  if (desk) {
    await fetch(`${serverUrl}/workspaces/${workspaceId}/default-agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ agentId: desk.id }),
    });
  }
  const candidate = memberships.find(m => m.name === candidateName);
  if (candidate) {
    await fetch(`${serverUrl}/agents/${candidate.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  }
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
  await dialog.getByRole("button", { name: /Add custom agent/i }).click();

  // Editor uses the default model; no need to touch the picker (which is
  // empty in the e2e lane anyway).
  await dialog.getByLabel("Agent name").fill(initialName);
  await dialog
    .getByPlaceholder(/How should this agent behave/i)
    .fill("Be concise.");
  await dialog.getByRole("button", { name: /^Create agent$/i }).click();

  // New agent row is rendered from the invalidated GET /agents list.
  await expect(dialog.getByText(initialName)).toBeVisible({ timeout: 5_000 });

  // Server row exists with the instructions we typed.
  {
    const res = await fetch(`${serverUrl}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const list = (await res.json()) as Array<{
      id: string;
      name: string;
      instructions: string;
    }>;
    const created = list.find(a => a.name === initialName);
    expect(created?.instructions).toBe("Be concise.");
  }

  // Hover the row to reveal the edit button, then rename.
  const row = dialog.locator("div.group", { hasText: initialName }).first();
  await row.hover();
  await row.getByRole("button", { name: `Edit ${initialName}` }).click();

  const nameInput = dialog.getByLabel("Agent name");
  await nameInput.fill(renamedName);
  await dialog.getByRole("button", { name: /^Save$/ }).click();

  await expect(dialog.getByText(renamedName)).toBeVisible({ timeout: 5_000 });
  await expect(dialog.getByText(initialName)).toHaveCount(0);

  // Delete via trash + confirm popover.
  const renamedRow = dialog.locator("div.group", { hasText: renamedName }).first();
  await renamedRow.hover();
  await renamedRow.getByRole("button", { name: `Delete ${renamedName}` }).click();
  await loggedInPage.getByRole("button", { name: /^Delete$/ }).click();

  await expect(dialog.getByText(renamedName)).toHaveCount(0, { timeout: 5_000 });

  // Server confirms it's gone.
  const res = await fetch(`${serverUrl}/agents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const list = (await res.json()) as Array<{ name: string }>;
  expect(list.find(a => a.name === renamedName)).toBeUndefined();
});
