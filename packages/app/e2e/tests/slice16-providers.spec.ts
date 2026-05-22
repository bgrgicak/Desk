/**
 * Slice 16 — Provider keys: ChatGPT/Claude live under My account → Models
 * (the new ModelsSection in global user settings); GitHub stays in
 * workspace Customize → Connections via the connector-credentials flow.
 * All three persist via PUT /me/providers and echo back masked from
 * GET /me/providers.
 */
import { test, expect } from "../fixtures";

async function deleteAgentByName(serverUrl: string, token: string, name: string) {
  const res = await fetch(`${serverUrl}/agents`, { headers: { Authorization: `Bearer ${token}` } });
  const list = (await res.json()) as Array<{ id: string; name: string }>;
  const match = list.find(a => a.name === name);
  if (!match) return;
  await fetch(`${serverUrl}/agents/${match.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function openModelsTab(page: import("@playwright/test").Page) {
  await page.getByTestId("account-avatar").click();
  await page.getByTestId("open-my-account").click();
  const dialog = page.getByRole("dialog");
  // The nav item now reads "AI providers" — same section, label clarified.
  await dialog.getByRole("button", { name: /^AI providers$/i }).click();
  return dialog;
}

async function openGitHubConnection(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /Settings/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Connections$/i }).click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByRole("button", { name: /GitHub/ }).click();
  return dialog;
}

test("storing a ChatGPT key persists and echoes back masked", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible({ timeout: 10_000 });

  const agentName = `spec16-chatgpt-${Date.now().toString(36)}`;

  let dialog = await openModelsTab(loggedInPage);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByLabel("Connection").selectOption("openai");
  await dialog.getByPlaceholder("e.g. Daily driver").fill(agentName);

  const input = dialog.getByTestId("model-provider-credential-OPENAI_API_KEY");
  await expect(input).toBeVisible();

  const longKey = "sk-test-1234567890abcdef".padEnd(40, "x");
  await input.fill(longKey);
  await dialog.getByRole("button", { name: /^Add model$/i }).click();

  // Server confirms — masking format is `prefix...suffix`.
  await expect.poll(async () => {
    const res = await fetch(`${serverUrl}/me/providers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { providers: Record<string, string | null> };
    return body.providers.OPENAI_API_KEY ?? null;
  }, { timeout: 5_000 }).not.toBeNull();

  // Reload — the masked echo is rendered in the credential scope panel
  // when re-opening the agent for edit.
  await loggedInPage.reload();
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible({ timeout: 10_000 });
  dialog = await openModelsTab(loggedInPage);

  const row = dialog.locator("div.group", { hasText: agentName }).first();
  await row.hover();
  await row.getByRole("button", { name: /^Edit$/ }).click();
  const scope = dialog.getByTestId("model-provider-credential-scope-OPENAI_API_KEY");
  await expect(scope).toBeVisible({ timeout: 5_000 });
  await expect(scope).toContainText("...");

  await deleteAgentByName(serverUrl, token, agentName);
});

test("adding a Claude model saves the API key from the footer action", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible({ timeout: 10_000 });

  const agentName = `spec16-claude-${Date.now().toString(36)}`;

  const dialog = await openModelsTab(loggedInPage);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByLabel("Connection").selectOption("anthropic");
  await dialog.getByPlaceholder("e.g. Daily driver").fill(agentName);

  const input = dialog.getByTestId("model-provider-credential-ANTHROPIC_API_KEY");
  await expect(input).toBeVisible();

  const longKey = "sk-ant-test-1234567890abcdef".padEnd(44, "x");
  await input.fill(longKey);
  await dialog.getByRole("button", { name: /^Add model$/i }).click();

  await expect.poll(async () => {
    const res = await fetch(`${serverUrl}/me/providers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { providers: Record<string, string | null> };
    return body.providers.ANTHROPIC_API_KEY ?? null;
  }, { timeout: 5_000 }).not.toBeNull();

  await deleteAgentByName(serverUrl, token, agentName);
});

test("GitHub connection explains token creation and sandbox use", async ({
  loggedInPage,
}) => {
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible({ timeout: 10_000 });

  const dialog = await openGitHubConnection(loggedInPage);

  await expect(dialog.getByTestId("github-token-guide")).toContainText("Tokens (classic)");
  await expect(dialog.getByTestId("github-token-guide")).toContainText("repo");
  await expect(dialog.getByTestId("github-token-guide")).toContainText("workflow");
  await expect(dialog.getByTestId("github-token-guide")).toContainText("GITHUB_TOKEN");
  await expect(dialog.getByTestId("connector-credentials-GITHUB_TOKEN")).toBeVisible();
});
