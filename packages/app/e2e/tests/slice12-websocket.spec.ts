/**
 * Slice 12 — WS layer: server-pushed events land in the store cache
 * without a page reload.
 *
 * Strategy:
 *   1. Open the app with a seeded chat visible in the sidebar.
 *   2. Delete that chat via the REST API.
 *   3. The server emits a chat.deleted WS event; the middleware should
 *      patch the getChats cache, so the sidebar entry vanishes without
 *      a reload.
 */
import { test, expect } from "../fixtures";

async function createChat(
  serverUrl: string,
  token: string,
  title: string,
): Promise<string> {
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
  const res = await fetch(`${serverUrl}/chats`, {
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
  const chat = (await res.json()) as { id: string };
  return chat.id;
}

test("chat.deleted WS event removes the sidebar entry without reload", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const chatId = await createChat(
    serverUrl,
    token,
    "Slice12 websocket removal",
  );
  await loggedInPage.reload();

  const chatButton = loggedInPage
    .getByRole("link", { name: /Slice12 websocket removal/ })
    .first();
  await expect(chatButton).toBeVisible({ timeout: 10_000 });

  // Delete the chat via the REST API. The server emits chat.deleted
  // on the WS; our middleware patches the getChats cache.
  const del = await fetch(`${serverUrl}/chats/${chatId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(del.status).toBe(200);

  // No reload — entry should disappear.
  await expect(chatButton).toHaveCount(0, { timeout: 10_000 });
});
