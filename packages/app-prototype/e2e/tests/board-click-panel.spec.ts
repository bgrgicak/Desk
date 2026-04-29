import { test, expect } from "../fixtures";

test("clicking a task card on the board opens the detail panel in the right sidebar", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const wsList = (await (
    await fetch(`${serverUrl}/workspaces`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;
  const agents = (await (
    await fetch(`${serverUrl}/agents`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: wsList[0].id,
        agentId: agents[0].id,
        title: "Board click test",
      }),
    })
  ).json()) as { id: string };

  const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: "Board click target",
      kind: "task",
      title: "Board click target",
      executeAt: futureIso,
    }),
  });

  await loggedInPage.reload();
  await loggedInPage.getByRole("button", { name: /^Tasks$/ }).first().click();

  const card = loggedInPage.getByText("Board click target").first();
  await expect(card).toBeVisible({ timeout: 10_000 });
  await loggedInPage.screenshot({ path: "/tmp/before-click.png", fullPage: false });
  await card.click();

  // Detail panel: schedule alert + meta rows render once selectedTask is set.
  await expect(loggedInPage.getByText(/Scheduled/).first()).toBeVisible({ timeout: 5_000 });
  await loggedInPage.screenshot({ path: "/tmp/after-click.png", fullPage: false });
});
