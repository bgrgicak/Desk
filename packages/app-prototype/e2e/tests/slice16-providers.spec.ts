/**
 * Slice 16 — Settings → Connections → Claude detail.
 *
 * Saving a provider key calls PUT /me/providers and the masked echo
 * comes back from GET /me/providers on reload. The API-key input lives
 * inside the Claude connection's detail page.
 */
import { test, expect } from "../fixtures";

async function openClaudeConnection(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /Customize/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Connections$/i }).click();
  // The Claude row's Edit button is hover-revealed; clicking the "More
  // actions" kebab → Edit is the deterministic path.
  const claudeRow = dialog.locator("div").filter({ hasText: /^Claude/ }).first();
  await claudeRow.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /^Edit$/ }).click();
  return dialog;
}

test("storing an Anthropic key persists and echoes back masked", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible();

  let dialog = await openClaudeConnection(loggedInPage);

  const input = dialog.getByTestId("provider-key-ANTHROPIC_API_KEY");
  await expect(input).toBeVisible();

  const longKey = "sk-ant-test-1234567890abcdef".padEnd(40, "x");
  await input.fill(longKey);
  await dialog.getByTestId("provider-save-ANTHROPIC_API_KEY").click();

  // Server confirms — masking format is `prefix...suffix`.
  await expect.poll(async () => {
    const res = await fetch(`${serverUrl}/me/providers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { providers: Record<string, string | null> };
    return body.providers.ANTHROPIC_API_KEY ?? null;
  }, { timeout: 5_000 }).not.toBeNull();

  // Reload — the masked echo from /me/providers is shown.
  await loggedInPage.reload();
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible();
  dialog = await openClaudeConnection(loggedInPage);

  const inputAfterReload = dialog.getByTestId("provider-key-ANTHROPIC_API_KEY");
  await expect(inputAfterReload).toBeVisible();
  // Server masks with `...` separator. Wait for the GET /me/providers to
  // populate the input (RTK Query is async).
  await expect.poll(() => inputAfterReload.inputValue(), { timeout: 5_000 }).toContain("...");
});
