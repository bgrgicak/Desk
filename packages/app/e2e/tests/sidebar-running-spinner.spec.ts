/**
 * Sidebar running-chat spinner — cold-start hydration.
 *
 * Strategy:
 *   1. Create a chat via REST API.
 *   2. Insert a system agent_turn message in `pending` state via REST,
 *      so the chat has a running message.
 *   3. Reload the page — the /chats endpoint returns `running: true`
 *      for this chat.
 *   4. Verify the sidebar shows a spinning loader (`data-testid="chat-running-spinner"`)
 *      next to the chat title, immediately on load (cold-start hydration).
 *   5. Verify the spinner disappears when the message transitions
 *      to `succeeded` via WS.
 */
import { test, expect } from "../fixtures";

async function createChatWithRunningMessage(
  serverUrl: string,
  token: string,
  title: string,
): Promise<{ chatId: string; messageId: string }> {
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

  // Create the chat
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

  // Send a user message which creates an agent_turn trigger in pending state.
  // The server creates a user message + a pending agent_turn trigger.
  const msgRes = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ content: "Please do something that takes a while" }),
  });
  const msgData = (await msgRes.json()) as { id: string };

  return { chatId: chat.id, messageId: msgData.id };
}

test("sidebar shows spinner for running chat on page load (cold-start hydration)", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const { chatId } = await createChatWithRunningMessage(
    serverUrl,
    token,
    "Running spinner test",
  );

  // Reload the page — the /chats endpoint should return running: true
  // for this chat, and the sidebar should show the spinner immediately.
  await loggedInPage.reload();

  // Wait for the sidebar to render with the chat
  const chatButton = loggedInPage
    .getByRole("link", { name: /Running spinner test/ })
    .first();
  await expect(chatButton).toBeVisible({ timeout: 10_000 });

  // The spinner should be visible within the chat row.
  const spinner = loggedInPage.locator('[data-testid="chat-running-spinner"]');
  await expect(spinner).toBeVisible({ timeout: 5_000 });

  // Clean up: delete the chat
  await fetch(`${serverUrl}/chats/${chatId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
});

test("sidebar spinner appears via WS when chat starts running", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  // First, verify no spinner exists
  const spinnersBefore = loggedInPage.locator('[data-testid="chat-running-spinner"]');
  const initialCount = await spinnersBefore.count();

  // Create a chat and send a message (which starts an agent turn)
  const { chatId } = await createChatWithRunningMessage(
    serverUrl,
    token,
    "WS spinner test",
  );

  // Wait for WS to push the pending agent_turn event to the sidebar
  const spinner = loggedInPage.locator('[data-testid="chat-running-spinner"]');
  await expect(spinner).toHaveCount(initialCount + 1, { timeout: 10_000 });

  // Clean up
  await fetch(`${serverUrl}/chats/${chatId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
});
