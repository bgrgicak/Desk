/**
 * Slice 4 — per-chat messages.
 *
 * Creates a chat + message server-side, opens the chat in the UI, and
 * confirms the text is rendered.
 */
import { test, expect } from "../fixtures";

interface CreatedChat {
  chatId: string;
  workspaceId: string;
  agentId: string;
}

async function seedChatWithMessage(
  serverUrl: string,
  token: string,
  title: string,
  body: string,
): Promise<CreatedChat> {
  const headers = { Authorization: `Bearer ${token}` };
  const wsList = (await (
    await fetch(`${serverUrl}/workspaces`, { headers })
  ).json()) as Array<{ id: string }>;
  const agentsList = (await (
    await fetch(`${serverUrl}/agents`, { headers })
  ).json()) as Array<{ id: string }>;

  const chatRes = await fetch(`${serverUrl}/chats`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: wsList[0].id,
      agentId: agentsList[0].id,
      title,
    }),
  });
  expect(chatRes.status).toBe(201);
  const chat = (await chatRes.json()) as { id: string };

  const msgRes = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ content: body }),
  });
  expect(msgRes.status).toBeGreaterThanOrEqual(200);
  expect(msgRes.status).toBeLessThan(300);

  return { chatId: chat.id, workspaceId: wsList[0].id, agentId: agentsList[0].id };
}

test("opening a chat shows its persisted messages", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  await seedChatWithMessage(
    serverUrl,
    token,
    "Slice4 history",
    "ping from the slice4 spec",
  );
  await loggedInPage.reload();

  // Click the chat in the sidebar.
  await loggedInPage
    .getByRole("button", { name: /Slice4 history/ })
    .first()
    .click();

  await expect(
    loggedInPage.getByText("ping from the slice4 spec").first(),
  ).toBeVisible({ timeout: 10_000 });
});
