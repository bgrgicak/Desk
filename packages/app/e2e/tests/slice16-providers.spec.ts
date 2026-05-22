/**
 * Slice 16 — Settings → Connections → ChatGPT detail.
 *
 * Saving a provider key calls PUT /me/providers and the masked echo
 * comes back from GET /me/providers on reload. The API-key input lives
 * inside the ChatGPT connection's detail page.
 */
import { test, expect } from "../fixtures";

async function openChatGPTConnection(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /Customize/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Connections$/i }).click();
  // The Connections tab now renders two sections under the same `div.group`
  // wrapper: configured connections (with a "More actions" menu → Edit) and
  // available kinds (with a "Connect" button that opens the new-connection
  // detail view directly). On first run only the Available row exists; after
  // a key is saved the configured row appears above it. We branch on which
  // affordance the row exposes rather than waiting for a button that may
  // never show up.
  const chatgptRow = dialog.locator("div.group", { hasText: /^ChatGPT/ }).first();
  await chatgptRow.waitFor({ state: "visible", timeout: 5_000 });
  const moreActions = chatgptRow.getByRole("button", { name: "More actions" });
  if (await moreActions.count()) {
    await moreActions.click();
    await page.getByRole("menuitem", { name: /^Edit$/ }).click();
  } else {
    await chatgptRow.getByRole("button", { name: /^Connect( another)?$/ }).click();
  }
  return dialog;
}

async function openGitHubConnection(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /Customize/ }).click();
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

  let dialog = await openChatGPTConnection(loggedInPage);

  const input = dialog.getByTestId("provider-key-OPENAI_API_KEY");
  await expect(input).toBeVisible();

  const longKey = "sk-test-1234567890abcdef".padEnd(40, "x");
  await input.fill(longKey);
  await dialog.getByTestId("provider-save-OPENAI_API_KEY").click();

  // Server confirms — masking format is `prefix...suffix`.
  await expect.poll(async () => {
    const res = await fetch(`${serverUrl}/me/providers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { providers: Record<string, string | null> };
    return body.providers.OPENAI_API_KEY ?? null;
  }, { timeout: 5_000 }).not.toBeNull();

  // Reload — the masked echo from /me/providers is shown.
  await loggedInPage.reload();
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible({ timeout: 10_000 });
  dialog = await openChatGPTConnection(loggedInPage);

  const inputAfterReload = dialog.getByTestId("provider-key-OPENAI_API_KEY");
  await expect(inputAfterReload).toBeVisible();
  // Server masks with `...` separator. Wait for the GET /me/providers to
  // populate the input (RTK Query is async).
  await expect.poll(() => inputAfterReload.inputValue(), { timeout: 5_000 }).toContain("...");
});

test("adding an API-key connection saves the key from the footer action", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible({ timeout: 10_000 });

  await loggedInPage.getByRole("button", { name: /Customize/ }).click();
  const dialog = loggedInPage.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Connections$/i }).click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByRole("button", { name: /Claude/ }).click();

  const input = dialog.getByTestId("provider-key-ANTHROPIC_API_KEY");
  await expect(input).toBeVisible();

  const longKey = "sk-ant-test-1234567890abcdef".padEnd(44, "x");
  await input.fill(longKey);
  await dialog.getByRole("button", { name: /^Add connection$/ }).click();

  await expect.poll(async () => {
    const res = await fetch(`${serverUrl}/me/providers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { providers: Record<string, string | null> };
    return body.providers.ANTHROPIC_API_KEY ?? null;
  }, { timeout: 5_000 }).not.toBeNull();
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
  await expect(dialog.getByTestId("provider-key-GITHUB_TOKEN")).toBeVisible();
});
