/**
 * Slice 13 — Task lifecycle (pause / resume / cancel) + chat deep-link.
 *
 * Seeds a `kind='task'` self-firing message scheduled 24h in the future
 * via the memory schedule adapter — the row stays pending forever and is
 * the stable scheduled task we drive the panel against. (The previous
 * ai_note_request fixture moved to `kind='ai_note'` and no longer
 * surfaces on the Tasks page; tasks must be `kind='task'`.)
 */
import { test, expect } from "../fixtures";

interface Seeded {
  chatId: string;
  messageId: string;
  workspaceId: string;
  chatTitle: string;
}

async function seedScheduledTask(
  serverUrl: string,
  token: string,
  chatTitle: string,
): Promise<Seeded> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const authHeaders = { Authorization: `Bearer ${token}` };
  const wsList = (await (
    await fetch(`${serverUrl}/workspaces`, { headers: authHeaders })
  ).json()) as Array<{ id: string }>;
  const agents = (await (
    await fetch(`${serverUrl}/agents`, { headers: authHeaders })
  ).json()) as Array<{ id: string }>;

  const chatRes = await fetch(`${serverUrl}/chats`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      workspaceId: wsList[0].id,
      agentId: agents[0].id,
      title: chatTitle,
    }),
  });
  expect(chatRes.status).toBe(201);
  const chat = (await chatRes.json()) as { id: string };

  const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const postRes = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: chatTitle,
      kind: "task",
      title: chatTitle,
      executeAt: futureIso,
    }),
  });
  expect(postRes.status).toBeGreaterThanOrEqual(200);
  expect(postRes.status).toBeLessThan(300);
  const taskMsg = (await postRes.json()) as { id: string };

  return {
    chatId: chat.id,
    messageId: taskMsg.id,
    workspaceId: wsList[0].id,
    chatTitle,
  };
}

async function readMessageState(
  serverUrl: string,
  token: string,
  chatId: string,
  messageId: string,
): Promise<string | undefined> {
  const res = await fetch(`${serverUrl}/chats/${chatId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { items: Array<{ id: string; state?: string }> };
  return body.items.find((m) => m.id === messageId)?.state;
}

async function openTaskDetail(
  page: import("@playwright/test").Page,
  seeded: Seeded,
) {
  await page.reload();
  await page.getByRole("button", { name: /^Tasks$/ }).first().click();
  await page.getByTestId(`task-row-${seeded.messageId}`).click();
  await expect(page.getByTestId("task-status-trigger")).toBeVisible({ timeout: 5_000 });
}

test("task detail panel pauses, resumes, and cancels the server message", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const seeded = await seedScheduledTask(serverUrl, token, "Slice13 lifecycle");
  await openTaskDetail(loggedInPage, seeded);

  // Pause.
  await loggedInPage.getByTestId("task-pause").click();
  await expect
    .poll(() => readMessageState(serverUrl, token, seeded.chatId, seeded.messageId), {
      timeout: 5_000,
    })
    .toBe("paused");
  await expect(loggedInPage.getByTestId("task-resume")).toBeVisible();

  // Resume.
  await loggedInPage.getByTestId("task-resume").click();
  await expect
    .poll(() => readMessageState(serverUrl, token, seeded.chatId, seeded.messageId), {
      timeout: 5_000,
    })
    .toBe("pending");
  await expect(loggedInPage.getByTestId("task-pause")).toBeVisible();

  // Cancel.
  await loggedInPage.getByTestId("task-cancel").click();
  await expect
    .poll(() => readMessageState(serverUrl, token, seeded.chatId, seeded.messageId), {
      timeout: 5_000,
    })
    .toBe("cancelled");
});

test("task detail chat tab links to originating chat with message deep-link", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const seeded = await seedScheduledTask(serverUrl, token, "Slice13 chat link");
  await openTaskDetail(loggedInPage, seeded);

  await loggedInPage.getByRole("button", { name: /^Chat$/ }).click();
  const openInChat = loggedInPage.getByTestId("open-in-chat");
  await expect(openInChat).toBeVisible();
  await openInChat.click();

  await expect(loggedInPage).toHaveURL(
    new RegExp(`/w/${seeded.workspaceId}/desk\\?.*chat=${seeded.chatId}.*message=${seeded.messageId}`),
  );
});

test("scheduled-but-never-fired task hides the 'Last run' row", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const seeded = await seedScheduledTask(serverUrl, token, "Slice13 no last run");
  await openTaskDetail(loggedInPage, seeded);

  await expect(loggedInPage.getByText("Next run")).toBeVisible();
  await expect(loggedInPage.getByText(/^Last run$/)).toHaveCount(0);
  await expect(loggedInPage.getByTestId("task-history-empty")).toBeVisible();
});
