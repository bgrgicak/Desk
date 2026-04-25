/**
 * Slice 13 — Task lifecycle (pause / resume / cancel) + chat deep-link.
 *
 * Server-side, a user message POST also enqueues a scheduled
 * ai_note_request 30 min in the future (via runManager.scheduleAiNote).
 * With the memory schedule adapter, that row stays pending forever and
 * is the stable scheduled task we drive the panel against.
 *
 * (Same coverage as the original slice13-run-lifecycle; selectors and
 * URL paths track the runs → tasks rename.)
 */
import { test, expect } from "../fixtures";

interface Seeded {
  chatId: string;
  messageId: string;
  workspaceId: string;
  chatTitle: string;
}

async function seedAiNoteTask(
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

  const postRes = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "seed for ai_note_request" }),
  });
  expect(postRes.status).toBeGreaterThanOrEqual(200);
  expect(postRes.status).toBeLessThan(300);

  const noteId = await pollForAiNoteRequest(serverUrl, token, chat.id);
  if (!noteId) {
    throw new Error("scheduleAiNote didn't surface an ai_note_request row");
  }

  return {
    chatId: chat.id,
    messageId: noteId,
    workspaceId: wsList[0].id,
    chatTitle,
  };
}

async function pollForAiNoteRequest(
  serverUrl: string,
  token: string,
  chatId: string,
): Promise<string | null> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${serverUrl}/chats/${chatId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { items: Array<{ id: string; content: { type: string }; state?: string }> };
    const row = body.items.find(
      (m) => m.content.type === "ai_note_request" && m.state === "pending",
    );
    if (row) return row.id;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
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
  await page.getByTestId("tasks-view-list").click();
  await page.getByTestId(`task-row-${seeded.messageId}`).click();
  await expect(page.getByText(/Scheduled for|Paused/).first()).toBeVisible({ timeout: 5_000 });
}

test("task detail panel pauses, resumes, and cancels the server message", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const seeded = await seedAiNoteTask(serverUrl, token, "Slice13 lifecycle");
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
  const seeded = await seedAiNoteTask(serverUrl, token, "Slice13 chat link");
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
  const seeded = await seedAiNoteTask(serverUrl, token, "Slice13 no last run");
  await openTaskDetail(loggedInPage, seeded);

  await expect(loggedInPage.getByText("Next run")).toBeVisible();
  await expect(loggedInPage.getByText(/^Last run$/)).toHaveCount(0);
  await expect(loggedInPage.getByTestId("task-history-empty")).toBeVisible();
});
