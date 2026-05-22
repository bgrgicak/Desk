/**
 * Slice 10 — server-backed search in the global palette (Cmd+K).
 */
import { test, expect } from "../fixtures";

test("search palette returns server results", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  // Seed: create a chat whose message body is a distinctive search target.
  // The title intentionally does not include the token so we cover body-only
  // chat hits; the palette must not hide server results with client filtering.
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;
  const agents = (await (
    await fetch(`${serverUrl}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const title = "ZZZ unrelated chat";
  const chatRes = await fetch(`${serverUrl}/chats`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      workspaceId: ws[0].id,
      agentId: agents[0].id,
      title,
    }),
  });
  const chat = (await chatRes.json()) as { id: string };

  await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ content: "searchableMoose indexed body" }),
  });

  await loggedInPage.reload();

  // Wait for the AppShell to mount before reaching for the palette
  // button — CI is slow enough that the default `.click()` auto-wait
  // sometimes hits the test's 30 s timeout before the React tree
  // settles. The avatar shows up at the same time as the rest of the
  // chrome.
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible();

  // Open the global palette via the keyboard shortcut — the navbar
  // Search·Ask AI button was removed in the Home/TopBar redesign; the
  // Cmd/Ctrl+K binding (GlobalPaletteProvider) is the only trigger now.
  await loggedInPage.keyboard.press("ControlOrMeta+k");

  // Type enough to trigger the server query.
  await loggedInPage.getByPlaceholder(/Search across all your rooms/).fill("searchableMoose");

  await expect(
    loggedInPage.getByRole("option", { name: /searchableMoose/i }).first(),
  ).toBeVisible();

  await expect(
    loggedInPage.getByText("ZZZ unrelated chat").first(),
  ).toBeVisible({ timeout: 10_000 });
});
