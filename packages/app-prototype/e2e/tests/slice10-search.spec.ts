/**
 * Slice 10 — server-backed search in the chat palette.
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

  // Open the global search / Ask AI palette.
  await loggedInPage.getByRole("button", { name: /Search.*Ask AI/i }).click();

  // Type enough to trigger the server query.
  await loggedInPage.getByPlaceholder(/Ask a question or search/).fill("searchableMoose");

  await expect(
    loggedInPage.getByText("ZZZ searchableMoose chat").first(),
  ).toBeVisible({ timeout: 10_000 });
});
