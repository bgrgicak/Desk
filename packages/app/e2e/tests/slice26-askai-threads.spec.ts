/**
 * Slice 26 — Ask AI thread support on the home screen.
 *
 * Verifies that the Ask AI view on the home screen:
 * 1. Shows the right-panel toggle button (Files / Tasks / Threads).
 * 2. Opening a thread chat stays on the home screen URL (`?chat=<id>`).
 * 3. The ThreadParentChip back-link resolves to the default Ask AI view.
 * 4. Clicking "Ask AI" in the sidebar resets to the default view.
 */
import { test, expect } from "../fixtures";

interface AskAiSetup {
  askAiChatId: string;
  messageChatId: string;
  messageId: string;
  threadChatId: string;
}

async function seedAskAiThread(
  serverUrl: string,
  token: string,
): Promise<AskAiSetup> {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // 1. Get (or create) the per-user Ask AI chat.
  const askAiRes = await fetch(`${serverUrl}/me/ask-ai-chat`, { headers });
  expect(askAiRes.status).toBe(200);
  const askAiChat = (await askAiRes.json()) as { id: string };

  // 2. Post a user message to the Ask AI chat.
  const msgRes = await fetch(
    `${serverUrl}/chats/${askAiChat.id}/messages`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "slice26 anchor message" }),
    },
  );
  expect(msgRes.status).toBeGreaterThanOrEqual(200);
  expect(msgRes.status).toBeLessThan(300);
  const msg = (await msgRes.json()) as { id: string };

  // 3. Create a thread anchored at that message.
  const threadRes = await fetch(
    `${serverUrl}/chats/${askAiChat.id}/messages/${msg.id}/thread`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "slice26 thread reply" }),
    },
  );
  expect(threadRes.status).toBe(201);
  const { chat: threadChat } = (await threadRes.json()) as {
    chat: { id: string };
  };

  return {
    askAiChatId: askAiChat.id,
    messageChatId: askAiChat.id,
    messageId: msg.id,
    threadChatId: threadChat.id,
  };
}

test("Ask AI view shows the right-panel toggle button", async ({
  loggedInPage,
  baseURL,
}) => {
  if (!baseURL) throw new Error("playwright baseURL is required");
  await loggedInPage.goto(new URL("/?view=askai", baseURL).toString());

  // The panel toggle button is rendered by RoomTopBarActions into the
  // home top bar. It should appear now that the Ask AI view no longer
  // hides the panel.
  await expect(
    loggedInPage.getByRole("button", { name: /open side panel/i }),
  ).toBeVisible({ timeout: 10_000 });
});

test("opening a thread from Ask AI stays on the home screen", async ({
  loggedInPage,
  serverUrl,
  token,
  baseURL,
}) => {
  if (!baseURL) throw new Error("playwright baseURL is required");
  const { threadChatId } = await seedAskAiThread(serverUrl, token);

  // Navigate directly to the thread inside the Ask AI view.
  const threadUrl = new URL(
    `/?view=askai&chat=${threadChatId}`,
    baseURL,
  ).toString();
  await loggedInPage.goto(threadUrl);

  // URL should stay on the home screen (no /w/ room path).
  expect(loggedInPage.url()).toContain("view=askai");
  expect(loggedInPage.url()).toContain(`chat=${threadChatId}`);
  expect(loggedInPage.url()).not.toContain("/w/");
});

test("ThreadParentChip back-link in Ask AI thread navigates to default Ask AI view", async ({
  loggedInPage,
  serverUrl,
  token,
  baseURL,
}) => {
  if (!baseURL) throw new Error("playwright baseURL is required");
  const { threadChatId } = await seedAskAiThread(serverUrl, token);

  // Open the thread.
  await loggedInPage.goto(
    new URL(`/?view=askai&chat=${threadChatId}`, baseURL).toString(),
  );

  // The "From …" breadcrumb chip should appear and link back to the Ask AI view.
  const backChip = loggedInPage.getByRole("link", { name: /^from /i });
  await expect(backChip).toBeVisible({ timeout: 10_000 });

  // The href should point to the home screen Ask AI view (no room path, no chat param).
  const href = await backChip.getAttribute("href");
  expect(href).toBeTruthy();
  expect(href).toContain("view=askai");
  expect(href).not.toContain("chat=");
  expect(href).not.toContain("/w/");

  // Clicking it must actually switch the displayed chat back to the default
  // Ask AI view — URL loses the ?chat= param.
  await backChip.click();
  await expect(loggedInPage).toHaveURL(/view=askai/, { timeout: 5_000 });
  expect(loggedInPage.url()).not.toContain("chat=");
});

test("Ask AI sidebar nav clears thread chat param", async ({
  loggedInPage,
  serverUrl,
  token,
  baseURL,
}) => {
  if (!baseURL) throw new Error("playwright baseURL is required");
  const { threadChatId } = await seedAskAiThread(serverUrl, token);

  // Start on a thread.
  await loggedInPage.goto(
    new URL(`/?view=askai&chat=${threadChatId}`, baseURL).toString(),
  );
  await loggedInPage.waitForSelector("[data-testid], h1, textarea", {
    timeout: 10_000,
  });

  // Click "Ask AI" in the left sidebar — should navigate back to the
  // default Ask AI view (no ?chat= param).
  const askAiLink = loggedInPage.getByRole("link", { name: /^ask ai$/i });
  await askAiLink.click();

  await expect(loggedInPage).toHaveURL(/view=askai/, { timeout: 5_000 });
  expect(loggedInPage.url()).not.toContain("chat=");
});
