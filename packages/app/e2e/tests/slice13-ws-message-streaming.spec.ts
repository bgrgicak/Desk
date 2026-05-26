/**
 * Slice 13 — WS message streaming across all chat surfaces.
 *
 * After sending a message, the bubble must appear WITHOUT a page reload
 * (relying on the server's `message.appended` WS event patching the
 * RTK Query cache).  This guards against the silent race condition where
 * updateQueryData is a no-op because the cache was still pending when
 * the event arrived.
 *
 * Surfaces covered:
 *   1. Room chat     — ChatView (sets viewingChatId)
 *   2. Task chat     — TaskChatPanel (does NOT set viewingChatId)
 *   3. Library file  — FileChatPanel (does NOT set viewingChatId)
 *   4. Ask AI        — AskAiView → ChatView (same mechanics as room chat,
 *                      exercised via the root /?view=askai route)
 */
import { test, expect } from "../fixtures";

// ── helpers ──────────────────────────────────────────────────────────────────

async function getWorkspaceAndAgent(
  serverUrl: string,
  token: string,
): Promise<{ workspaceId: string; agentId: string }> {
  const headers = { Authorization: `Bearer ${token}` };
  const [wsList, agentsList] = await Promise.all([
    fetch(`${serverUrl}/workspaces`, { headers }).then((r) => r.json()) as Promise<Array<{ id: string }>>,
    fetch(`${serverUrl}/agents`, { headers }).then((r) => r.json()) as Promise<Array<{ id: string }>>,
  ]);
  return { workspaceId: wsList[0].id, agentId: agentsList[0].id };
}

async function createEmptyChat(
  serverUrl: string,
  token: string,
  workspaceId: string,
  agentId: string,
  title: string,
): Promise<string> {
  const res = await fetch(`${serverUrl}/chats`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, agentId, title }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function createTaskMessage(
  serverUrl: string,
  token: string,
  chatId: string,
  title: string,
): Promise<string> {
  const res = await fetch(`${serverUrl}/chats/${chatId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: title, kind: "task", title }),
  });
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
  return ((await res.json()) as { id: string }).id;
}

async function uploadTextFile(
  serverUrl: string,
  token: string,
  workspaceId: string,
  filename: string,
  body: string,
): Promise<string> {
  const boundary = `----roomy-ws-stream-${Math.random().toString(16).slice(2)}`;
  const buf = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`,
    ),
    Buffer.from(body, "utf8"),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await fetch(
    `${serverUrl}/library?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(buf.length),
      },
      body: buf,
    },
  );
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
  return ((await res.json()) as { path: string }).path;
}

// ── tests ─────────────────────────────────────────────────────────────────────

test("room chat: message appears via WS without reload", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const { workspaceId, agentId } = await getWorkspaceAndAgent(serverUrl, token);
  await createEmptyChat(serverUrl, token, workspaceId, agentId, "WS stream room chat");

  await loggedInPage.reload();
  await loggedInPage
    .getByRole("link", { name: /WS stream room chat/ })
    .first()
    .click();

  const textarea = loggedInPage.locator("textarea").last();
  await textarea.waitFor({ state: "visible", timeout: 10_000 });
  await loggedInPage.waitForTimeout(300);

  const body = "ws-stream-room-chat-" + Date.now();
  await textarea.fill(body);
  await textarea.press("Enter");

  await expect(loggedInPage.getByText(body).first()).toBeVisible({ timeout: 10_000 });
});

test("task chat: message appears via WS without reload", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const { workspaceId, agentId } = await getWorkspaceAndAgent(serverUrl, token);
  const chatId = await createEmptyChat(serverUrl, token, workspaceId, agentId, "WS stream task");
  const taskId = await createTaskMessage(serverUrl, token, chatId, "WS stream task label");

  // Navigate to tasks page and wait for the task card to appear.
  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();

  const taskCard = loggedInPage.getByTestId(`task-card-${taskId}`);
  await expect(taskCard).toBeVisible({ timeout: 15_000 });

  // Click the card — this sets ?task=<taskId> in the URL and opens the panel.
  await taskCard.click();

  // The TaskChatPanel contains the chat input.
  const textarea = loggedInPage.locator("textarea").last();
  await textarea.waitFor({ state: "visible", timeout: 10_000 });
  await loggedInPage.waitForTimeout(300);

  const body = "ws-stream-task-reply-" + Date.now();
  await textarea.fill(body);
  await textarea.press("Enter");

  await expect(loggedInPage.getByText(body).first()).toBeVisible({ timeout: 10_000 });
});

test("library file chat: message appears via WS without reload", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const { workspaceId } = await getWorkspaceAndAgent(serverUrl, token);

  const filename = `ws-stream-lib-${Date.now()}.txt`;
  await uploadTextFile(serverUrl, token, workspaceId, filename, "hello ws stream\n");

  // Navigate to the library and open the file detail.
  await loggedInPage.reload();
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible();
  await loggedInPage.getByRole("link", { name: /^Library$/ }).first().click();
  const row = loggedInPage.getByText(filename).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(loggedInPage.getByTestId("library-detail-more")).toBeVisible({
    timeout: 10_000,
  });

  // On a fresh session the chat panel may be closed. Click "Open chat" if needed.
  const openChatBtn = loggedInPage.getByRole("button", { name: "Open chat" });
  if (await openChatBtn.isVisible()) {
    await openChatBtn.click();
  }

  // FileChatPanel's ChatInput renders a textarea.
  const textarea = loggedInPage.locator("textarea").last();
  await textarea.waitFor({ state: "visible", timeout: 10_000 });
  await loggedInPage.waitForTimeout(300);

  const body = "ws-stream-library-" + Date.now();
  await textarea.fill(body);
  await textarea.press("Enter");

  await expect(loggedInPage.getByText(body).first()).toBeVisible({ timeout: 10_000 });
});

test("ask ai: message appears via WS without reload", async ({
  loggedInPage: page,
  serverUrl,
  token,
}) => {
  // Ask AI uses ChatView (same WS mechanics as room chat) but is routed
  // through the root /?view=askai path via AppBoot → HomePage → AskAiView.
  // Exercising this surface validates the whole /me/ask-ai-chat bootstrap.
  const headers = { Authorization: `Bearer ${token}` };
  const wsList = (await (
    await fetch(`${serverUrl}/workspaces`, { headers })
  ).json()) as Array<{ id: string }>;
  const wsId = wsList[0].id;

  // Navigate to the Ask AI view from the root. The session cookie from
  // the fixture carries over; AppBoot → HomePage renders with view=askai.
  await page.goto(`/?view=askai`);

  // AskAiView fetches /me/ask-ai-chat, then mounts ChatView with a textarea.
  const textarea = page.locator("textarea").last();
  await textarea.waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(500);

  const body = "ws-stream-askai-" + Date.now() + "-" + wsId.slice(0, 8);
  await textarea.fill(body);
  await textarea.press("Enter");

  await expect(page.getByText(body).first()).toBeVisible({ timeout: 10_000 });
});
