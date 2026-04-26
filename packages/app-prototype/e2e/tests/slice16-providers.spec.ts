/**
 * Slice 16 — Settings → Providers panel.
 *
 * Saving a provider key calls PUT /me/providers and the masked echo
 * comes back from GET /me/providers on reload.
 */
import { test, expect } from "../fixtures";

test("storing an Anthropic key persists and echoes back masked", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible();

  await loggedInPage.getByRole("button", { name: /Customize/ }).click();
  const dialog = loggedInPage.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Agents$/i }).click();

  // Providers panel is rendered below the agents list.
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
  await loggedInPage.getByRole("button", { name: /Customize/ }).click();
  await loggedInPage.getByRole("dialog").getByRole("button", { name: /^Agents$/i }).click();
  const inputAfterReload = loggedInPage.getByTestId("provider-key-ANTHROPIC_API_KEY");
  await expect(inputAfterReload).toBeVisible();
  // Server masks with `...` separator. Wait for the GET /me/providers to
  // populate the input (RTK Query is async).
  await expect.poll(() => inputAfterReload.inputValue(), { timeout: 5_000 }).toContain("...");
});
