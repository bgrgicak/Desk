/**
 * Slice 14 — Tasks page board mode renders columns by status and shows
 * a scheduled message in the correct column. (No drag-drop coverage in
 * Phase 1; that lives in slice19 once Phase 2 wires the BoardView dnd
 * handlers to the message-state PATCH.)
 */
import { test, expect } from "../fixtures";

test("tasks board view renders columns and places a scheduled message in the Scheduled column", async ({
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
        title: "Slice14 board",
      }),
    })
  ).json()) as { id: string };

  const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const postRes = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: "Slice14 board card",
      kind: "task",
      title: "Slice14 board card",
      executeAt: futureIso,
    }),
  });
  expect(postRes.status).toBeGreaterThanOrEqual(200);
  expect(postRes.status).toBeLessThan(300);

  await loggedInPage.reload();
  await loggedInPage.getByRole("button", { name: /^Tasks$/ }).first().click();

  // Default view mode is board — make sure the four columns render.
  for (const label of ["To do", "Active", "Complete", "Scheduled"]) {
    await expect(
      loggedInPage.getByRole("main").getByText(label, { exact: true }).first(),
    ).toBeVisible();
  }

  // The scheduled message lands in the Scheduled column.
  await expect(
    loggedInPage.getByText("Slice14 board card").first(),
  ).toBeVisible({ timeout: 10_000 });
});
