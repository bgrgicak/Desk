/**
 * Slice 13 — Run lifecycle (pause / resume / cancel) + chat deep-link.
 *
 * Server-side, a user message POST also enqueues a scheduled
 * ai_note_request 30 min in the future (via runManager.scheduleAiNote).
 * With the memory schedule adapter, that row stays pending forever and
 * is the stable scheduled run we drive the panel against.
 */
import { test, expect } from "../fixtures";

interface Seeded {
  chatId: string;
  messageId: string;
  workspaceId: string;
  /** Run title shown in the list — nameFor() falls back to the content
   * type when there's no text, so every ai_note_request lists as
   * "ai_note_request". We select it by chat context, not title. */
  chatTitle: string;
}

async function seedAiNoteRun(
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

  // Any user POST triggers scheduleAiNote server-side. The resulting
  // ai_note_request row has state=pending + executeAt 30min out and
  // stays pending under the memory adapter (no real fire path).
  const postRes = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "seed for ai_note_request" }),
  });
  expect(postRes.status).toBeGreaterThanOrEqual(200);
  expect(postRes.status).toBeLessThan(300);

  // Poll the chat's messages for the ai_note_request row. The server
  // schedules it async (fireMessage for the user turn runs in parallel),
  // so a small wait is expected.
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

async function openRunDetail(
  page: import("@playwright/test").Page,
  seeded: Seeded,
) {
  await page.reload();
  await page.getByRole("button", { name: /^Runs$/ }).first().click();
  await page.getByRole("button", { name: /List/i }).first().click();
  // Every ai_note_request carries the same title ("ai_note_request"),
  // so we target the specific row by its server message id.
  await page.getByTestId(`run-row-${seeded.messageId}`).click();
  // Wait until the detail panel is populated — Details tab is default.
  await expect(page.getByText(/Scheduled for|Paused/).first()).toBeVisible({ timeout: 5_000 });
}

test("run detail panel pauses, resumes, and cancels the server message", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const seeded = await seedAiNoteRun(serverUrl, token, "Slice13 lifecycle");
  await openRunDetail(loggedInPage, seeded);

  // Pause.
  await loggedInPage.getByTestId("run-pause").click();
  await expect
    .poll(() => readMessageState(serverUrl, token, seeded.chatId, seeded.messageId), {
      timeout: 5_000,
    })
    .toBe("paused");
  await expect(loggedInPage.getByTestId("run-resume")).toBeVisible();

  // Resume.
  await loggedInPage.getByTestId("run-resume").click();
  await expect
    .poll(() => readMessageState(serverUrl, token, seeded.chatId, seeded.messageId), {
      timeout: 5_000,
    })
    .toBe("pending");
  await expect(loggedInPage.getByTestId("run-pause")).toBeVisible();

  // Cancel.
  await loggedInPage.getByTestId("run-cancel").click();
  await expect
    .poll(() => readMessageState(serverUrl, token, seeded.chatId, seeded.messageId), {
      timeout: 5_000,
    })
    .toBe("cancelled");
});

test("run detail chat tab links to originating chat with message deep-link", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const seeded = await seedAiNoteRun(serverUrl, token, "Slice13 chat link");
  await openRunDetail(loggedInPage, seeded);

  // Chat tab shows a single "Open in chat" button — no mock transcript.
  await loggedInPage.getByRole("button", { name: /^Chat$/ }).click();
  const openInChat = loggedInPage.getByTestId("open-in-chat");
  await expect(openInChat).toBeVisible();
  await openInChat.click();

  // URL carries chat + message so ChatView can scroll to the target row
  // once messages load. System messages (ai_note_request) are filtered
  // from the chat timeline, so the message won't be visible — the
  // deep-link is still the correct behaviour for visible rows.
  await expect(loggedInPage).toHaveURL(
    new RegExp(`/w/${seeded.workspaceId}/desk\\?.*chat=${seeded.chatId}.*message=${seeded.messageId}`),
  );
});

test("scheduled-but-never-fired run hides the 'Last run' row", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const seeded = await seedAiNoteRun(serverUrl, token, "Slice13 no last run");
  await openRunDetail(loggedInPage, seeded);

  await expect(loggedInPage.getByText("Next run")).toBeVisible();
  await expect(loggedInPage.getByText(/^Last run$/)).toHaveCount(0);
  await expect(loggedInPage.getByTestId("run-history-empty")).toBeVisible();
});
