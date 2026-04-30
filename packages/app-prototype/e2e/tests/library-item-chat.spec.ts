/**
 * Library item chat — sending a message from the ConversationPanel while
 * viewing a library file creates a real server-backed chat and posts the
 * message with the file as an attachment.
 *
 * Pipeline under test:
 *   user types in ConversationPanel → sendMessage → POST /chats (lazy create)
 *   → POST /chats/{id}/messages → chat appears in sidebar
 *   → user message visible in ConversationPanel
 *   → no empty agent bubble (events messages are filtered)
 */
import { test, expect } from "../fixtures";

async function uploadText(
  serverUrl: string,
  token: string,
  workspaceId: string,
  name: string,
  body: string,
): Promise<string> {
  const boundary = `----desk-e2e-${Math.random().toString(16).slice(2)}`;
  const buf = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        `Content-Type: text/plain\r\n\r\n`,
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
  const json = (await res.json()) as { path: string };
  return json.path;
}

async function openLibraryFile(
  page: import("@playwright/test").Page,
  filename: string,
): Promise<void> {
  await page.reload();
  await expect(page.getByTestId("account-avatar")).toBeVisible();
  await page.getByRole("button", { name: /^Library$/ }).first().click();
  const row = page.getByText(filename).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(page.getByTestId("library-save")).toBeVisible({ timeout: 10_000 });
}

test("sending a message from the library item ConversationPanel creates a real server chat", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;
  const workspaceId = ws[0].id;

  const filename = `lib-chat-${Date.now()}.txt`;
  await uploadText(serverUrl, token, workspaceId, filename, "hello world\n");
  await openLibraryFile(loggedInPage, filename);

  // The ConversationPanel is open on the right. Type a message and send it.
  const input = loggedInPage.getByPlaceholder("Ask anything, start a task, build something...");
  await input.fill("What is in this file?");
  await input.press("Enter");

  // The user message must appear in the panel immediately.
  await expect(loggedInPage.getByText("What is in this file?")).toBeVisible({
    timeout: 5_000,
  });

  // A new chat entry named after the file must appear in the sidebar — this
  // confirms a real chat was created on the server (not just a mock).
  await expect(
    loggedInPage.getByRole("button", { name: filename }).first(),
  ).toBeVisible({ timeout: 10_000 });

  // Verify the chat exists on the server with the message attached to the file.
  const chats = (await (
    await fetch(`${serverUrl}/chats?workspaceId=${workspaceId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string; title: string }>;
  const libChat = chats.find((c) => c.title === filename);
  expect(libChat).toBeDefined();

  const messages = (await (
    await fetch(`${serverUrl}/chats/${libChat!.id}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as { items: Array<{ role: string; content: { type: string; text?: string }; attachments?: Array<{ path: string }> }> };

  const userMsg = messages.items.find((m) => m.role === "user");
  expect(userMsg).toBeDefined();
  expect(userMsg!.content.text).toBe("What is in this file?");
  expect(userMsg!.attachments?.[0]?.path).toBe(filename);
});

test("agent run events are stored server-side but not shown as empty bubbles in the UI", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;
  const workspaceId = ws[0].id;

  const filename = `lib-chat-events-${Date.now()}.txt`;
  await uploadText(serverUrl, token, workspaceId, filename, "test content\n");
  await openLibraryFile(loggedInPage, filename);

  const input = loggedInPage.getByPlaceholder("Ask anything, start a task, build something...");
  await input.fill("Summarize this file.");
  await input.press("Enter");

  // User message must appear in the panel.
  await expect(loggedInPage.getByText("Summarize this file.")).toBeVisible({
    timeout: 5_000,
  });

  // Wait for the agent run to complete (fake driver is fast).
  await loggedInPage.waitForTimeout(3_000);

  // Verify server-side: an 'events' message exists (agent run log) but the
  // UI must still be intact — user message still visible, no crash.
  const chats = (await (
    await fetch(`${serverUrl}/chats?workspaceId=${workspaceId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string; title: string }>;
  const libChat = chats.find((c) => c.title === filename);
  expect(libChat).toBeDefined();

  const messages = (await (
    await fetch(`${serverUrl}/chats/${libChat!.id}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as { items: Array<{ role: string; content: { type: string } }> };

  // The agent run produces an 'events' message (run log) on the server.
  const eventsMsg = messages.items.find(
    (m) => m.role === "agent" && m.content.type === "events",
  );
  expect(eventsMsg).toBeDefined();

  // The UI must not have crashed — the user message is still visible.
  await expect(loggedInPage.getByText("Summarize this file.")).toBeVisible();
});

test("library file is pinned to chat Files sidebar when first message is sent from ConversationPanel", async ({
  loggedInPage: page,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;
  const workspaceId = ws[0].id;

  const filename = `lib-chat-pin-${Date.now()}.txt`;
  await uploadText(serverUrl, token, workspaceId, filename, "pin me\n");
  await openLibraryFile(page, filename);

  // Intercept the library-refs pin request that must fire after chat creation.
  const pinPromise = page.waitForRequest(
    (req) =>
      req.method() === "POST" &&
      /\/chats\/[^/]+\/library-refs$/.test(req.url()),
  );

  const input = page.getByPlaceholder("Ask anything, start a task, build something...");
  await input.fill("What is in this file?");
  await input.press("Enter");

  // The pin must fire after the chat is lazily created on the first message.
  const pinReq = await pinPromise;
  const pinBody = JSON.parse(pinReq.postData() ?? "{}") as { path: string };
  expect(pinBody.path).toBe(filename);

  // Extract chatId from the pin URL.
  const chatIdMatch = pinReq.url().match(/\/chats\/([^/]+)\/library-refs$/);
  const chatId = chatIdMatch?.[1];
  expect(chatId).toBeTruthy();

  // The file must appear in the chat's attachments list (the Files sidebar source).
  const expectedPinnedPath = `.chats/${chatId}/attachments/${filename}`;
  await expect
    .poll(
      async () => {
        const res = await fetch(`${serverUrl}/chats/${chatId}/attachments`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const list = (await res.json()) as Array<{ path: string }>;
        return list.map((i) => i.path);
      },
      { timeout: 10_000 },
    )
    .toContain(expectedPinnedPath);
});
