/**
 * Slice 3 — chats (sidebar list + create + delete).
 */
import { test, expect } from "../fixtures";

async function createChat(
  serverUrl: string,
  token: string,
  title: string,
): Promise<string> {
  // Need a workspaceId + agentId. Fetch them.
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
  expect(res.status).toBe(201);
  const chat = (await res.json()) as { id: string };
  return chat.id;
}

test("chats the user has are listed in the sidebar", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  await createChat(serverUrl, token, "Slice3 persistent chat");
  await loggedInPage.reload();
  await expect(
    loggedInPage.getByRole("button", { name: /Slice3 persistent chat/ }).first(),
  ).toBeVisible({ timeout: 10_000 });
});

test("deleting a chat via the API removes it from the sidebar", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const chatId = await createChat(serverUrl, token, "Slice3 doomed chat");
  await loggedInPage.reload();
  await expect(
    loggedInPage.getByRole("button", { name: /Slice3 doomed chat/ }).first(),
  ).toBeVisible({ timeout: 10_000 });

  const del = await fetch(`${serverUrl}/chats/${chatId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(del.status).toBe(200);
  await loggedInPage.reload();
  await expect(
    loggedInPage.getByRole("button", { name: /Slice3 doomed chat/ }),
  ).toHaveCount(0);
});
