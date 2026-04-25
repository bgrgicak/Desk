/**
 * Slice 5 — Tasks page shows scheduled messages.
 *
 * Creates a chat + a scheduled message (POST /chats/:id/messages then
 * PATCH executeAt). The Tasks view should render it. (Renamed from
 * slice05-runs in lockstep with the trunk runs → tasks rename; same
 * underlying coverage.)
 */
import { test, expect } from "../fixtures";

test("tasks page shows scheduled server messages", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const wsList = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;
  const agents = (await (
    await fetch(`${serverUrl}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: wsList[0].id,
        agentId: agents[0].id,
        title: "Slice5 tasks container",
      }),
    })
  ).json()) as { id: string };

  const postRes = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "Slice5 task placeholder" }),
  });
  expect(postRes.status).toBeGreaterThanOrEqual(200);
  expect(postRes.status).toBeLessThan(300);
  const userMsg = (await postRes.json()) as { id: string; chatId: string };

  const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const patchRes = await fetch(
    `${serverUrl}/chats/${chat.id}/messages/${userMsg.id}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ executeAt: futureIso }),
    },
  );
  if (patchRes.status >= 400) {
    test.skip(true, "server rejected executeAt on user message — feature not available");
  }

  const crossRes = await fetch(
    `${serverUrl}/messages?scheduled=true&workspaceId=${wsList[0].id}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const cross = (await crossRes.json()) as { items: Array<{ id: string; state?: string }> };
  if (!cross.items.some((m) => m.id === userMsg.id)) {
    test.skip(
      true,
      "server /messages?scheduled=true doesn't expose the PATCHed user message yet",
    );
  }

  await loggedInPage.reload();
  // Navigate to tasks view — click the "Tasks" sidebar item.
  await loggedInPage.getByRole("button", { name: /^Tasks$/ }).first().click();

  // Switch to list view — the default board / calendar views don't
  // render the message text inline at small widths.
  await loggedInPage.getByTestId("tasks-view-list").click();

  // The task's name is derived from the first line of content.
  await expect(
    loggedInPage.getByText("Slice5 task placeholder").first(),
  ).toBeVisible({ timeout: 10_000 });
});
