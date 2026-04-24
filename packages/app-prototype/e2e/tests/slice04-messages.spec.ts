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

async function seedEmptyChat(
  serverUrl: string,
  token: string,
  title: string,
): Promise<string> {
  const headers = { Authorization: `Bearer ${token}` };
  const wsList = (await (
    await fetch(`${serverUrl}/workspaces`, { headers })
  ).json()) as Array<{ id: string }>;
  const agentsList = (await (
    await fetch(`${serverUrl}/agents`, { headers })
  ).json()) as Array<{ id: string }>;
  const res = await fetch(`${serverUrl}/chats`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: wsList[0].id,
      agentId: agentsList[0].id,
      title,
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test("typing in the chat posts the message to the server", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  await seedEmptyChat(serverUrl, token, "Slice4 live send");
  await loggedInPage.reload();

  await loggedInPage
    .getByRole("button", { name: /Slice4 live send/ })
    .first()
    .click();

  // Type a message into the chat input and submit with Ctrl+Enter. The
  // textarea's placeholder is dynamic (ChatInput re-infers a goal from the
  // typed text and swaps placeholders), so we locate by element role.
  const textarea = loggedInPage.locator("textarea").last();
  await textarea.waitFor({ state: "visible", timeout: 10_000 });
  const body = "hello from the slice4 live-send spec";
  await textarea.fill(body);
  await textarea.press("Enter");

  // Server-roundtrips the user message via WS → bubble appears.
  await expect(loggedInPage.getByText(body).first()).toBeVisible({
    timeout: 10_000,
  });

  // Bubble is not the mock response.
  await expect(
    loggedInPage.getByText("Done! I've updated the document with your changes."),
  ).toHaveCount(0);
});
