/**
 * Slice 24 — Task detail panel: Chat tab behaviour.
 *
 * Covers:
 * - "open-in-chat" button navigates to the originating chat with a message deep-link
 * - Messages that already exist in the task's chat are shown in the panel
 * - Empty state is shown when no conversation has happened yet
 * - A message typed and submitted in the panel appears in the list
 */
import { test, expect } from "../fixtures";

interface Seeded {
  chatId: string;
  messageId: string;
  workspaceId: string;
}

async function seedTask(serverUrl: string, token: string, title: string): Promise<Seeded> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const authHeaders = { Authorization: `Bearer ${token}` };

  const [wsList, agents] = await Promise.all([
    fetch(`${serverUrl}/workspaces`, { headers: authHeaders }).then((r) => r.json()) as Promise<Array<{ id: string }>>,
    fetch(`${serverUrl}/agents`, { headers: authHeaders }).then((r) => r.json()) as Promise<Array<{ id: string }>>,
  ]);

  const chatRes = await fetch(`${serverUrl}/chats`, {
    method: "POST",
    headers,
    body: JSON.stringify({ workspaceId: wsList[0].id, agentId: agents[0].id, title }),
  });
  expect(chatRes.status).toBe(201);
  const chat = (await chatRes.json()) as { id: string };

  const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const msgRes = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: title, kind: "task", title, executeAt: futureIso }),
  });
  expect(msgRes.status).toBeGreaterThanOrEqual(200);
  expect(msgRes.status).toBeLessThan(300);
  const taskMsg = (await msgRes.json()) as { id: string };

  return { chatId: chat.id, messageId: taskMsg.id, workspaceId: wsList[0].id };
}

async function openTaskChatTab(page: import("@playwright/test").Page, seeded: Seeded) {
  await page.reload();
  await page.getByRole("button", { name: /^Tasks$/ }).first().click();
  await page.getByTestId(`task-row-${seeded.messageId}`).click();
  await expect(page.getByTestId("task-status-trigger")).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: /^Chat$/ }).click();
}

test("chat tab shows empty state when task has no conversation yet", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const seeded = await seedTask(serverUrl, token, "Slice24 empty chat");
  await openTaskChatTab(loggedInPage, seeded);

  await expect(loggedInPage.getByTestId("task-chat-empty")).toBeVisible({ timeout: 5_000 });
});

test("chat tab shows the open-in-chat button linking to the originating chat", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const seeded = await seedTask(serverUrl, token, "Slice24 open in chat");
  await openTaskChatTab(loggedInPage, seeded);

  const btn = loggedInPage.getByTestId("open-in-chat");
  await expect(btn).toBeVisible({ timeout: 5_000 });
  await btn.click();

  await expect(loggedInPage).toHaveURL(
    new RegExp(`/w/${seeded.workspaceId}/desk\\?.*chat=${seeded.chatId}.*message=${seeded.messageId}`),
  );
});

test("chat tab displays messages that exist in the task's chat", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const seeded = await seedTask(serverUrl, token, "Slice24 show messages");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // Seed a regular follow-up message in the same chat (not a task, just text).
  const msgRes = await fetch(`${serverUrl}/chats/${seeded.chatId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "Slice24 existing message content" }),
  });
  expect(msgRes.status).toBeGreaterThanOrEqual(200);
  expect(msgRes.status).toBeLessThan(300);

  await openTaskChatTab(loggedInPage, seeded);

  await expect(
    loggedInPage.getByText("Slice24 existing message content"),
  ).toBeVisible({ timeout: 8_000 });
});

test("message typed in the chat tab appears in the message list after submit", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const seeded = await seedTask(serverUrl, token, "Slice24 send message");
  await openTaskChatTab(loggedInPage, seeded);

  const textarea = loggedInPage.locator("textarea");
  await textarea.waitFor({ state: "visible", timeout: 5_000 });
  await textarea.fill("Slice24 typed message");
  await textarea.press("Enter");

  await expect(
    loggedInPage.getByText("Slice24 typed message"),
  ).toBeVisible({ timeout: 8_000 });
});
