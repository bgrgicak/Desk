/**
 * Slice 10 — server-backed search in the global palette (Cmd+K).
 */
import { test, expect } from "../fixtures";

test("search palette returns server results", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  // Seed: create a chat whose title is a distinctive search target.
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

  const title = "ZZZ searchableMoose chat";
  await fetch(`${serverUrl}/chats`, {
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

  await loggedInPage.reload();

  // Wait for the AppShell to mount before reaching for the palette
  // button — CI is slow enough that the default `.click()` auto-wait
  // sometimes hits the test's 30 s timeout before the React tree
  // settles. The avatar shows up at the same time as the rest of the
  // chrome.
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible();

  // Open the global palette by clicking the navbar Search·Ask AI button.
  // (The same control responds to Cmd+K, but headless Chromium on Linux
  // doesn't reliably deliver Meta+K to the window keydown listener — the
  // button click is the deterministic path.)
  await loggedInPage
    .getByRole("button", { name: /Search.*Ask AI/i })
    .click();

  // Type enough to trigger the server query.
  await loggedInPage.getByPlaceholder(/Ask a question or search/).fill("searchableMoose");

  await expect(
    loggedInPage.getByText("ZZZ searchableMoose chat").first(),
  ).toBeVisible({ timeout: 10_000 });
});
