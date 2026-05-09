/**
 * Reproduces the user-reported regression — uploading a screenshot
 * (filename with spaces, dots in the middle, PNG bytes) into a chat —
 * and locks in the new upload contract:
 *
 *   Drop → in-memory chip in the composer → on send the file rides as
 *   a multipart `attachment[]` part on `POST /chats/{id}/messages`.
 *   Server writes it under `.chats/{id}/attachments/{name}` and the
 *   resulting message row carries it in `attachments[]`. There is no
 *   separate upload step, and no chat-id requirement at drop time
 *   (drops on the new-chat screen work too).
 */
import { test, expect } from "../fixtures";

const SCREENSHOT_NAME = "Screenshot 2026-04-28 at 17.29.34.png";

// Minimal valid 1x1 transparent PNG.
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

async function getFirstWorkspaceId(
  serverUrl: string,
  token: string,
): Promise<string> {
  const res = await fetch(`${serverUrl}/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const list = (await res.json()) as Array<{ id: string }>;
  return list[0].id;
}

test("library accepts a screenshot-style PNG (filename with spaces and dots)", async ({
  loggedInPage: page,
  serverUrl,
  token,
}) => {
  const workspaceId = await getFirstWorkspaceId(serverUrl, token);

  await page.getByRole("link", { name: /^Library$/ }).first().click();
  await page.waitForLoadState("networkidle");

  await page.locator('[data-testid="library-upload-button"]').first().click();

  await page
    .locator('[data-testid="dropzone-file-input"]')
    .first()
    .setInputFiles({
      name: SCREENSHOT_NAME,
      mimeType: "image/png",
      buffer: PNG_BYTES,
    });

  await expect(page.getByText(/^Upload failed:/)).not.toBeVisible();
  await expect(page.getByText(SCREENSHOT_NAME).first()).toBeVisible({
    timeout: 10_000,
  });

  const lib = (await (
    await fetch(
      `${serverUrl}/library?workspaceId=${encodeURIComponent(workspaceId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
  ).json()) as { items: Array<{ name: string; path: string }> };
  const entry = lib.items.find((i) => i.name === SCREENSHOT_NAME);
  expect(entry).toBeDefined();
  expect(entry!.path).toBe(SCREENSHOT_NAME);
});

test("chat: drop a screenshot → chip in composer → send rides on POST /messages multipart", async ({
  loggedInPage: page,
  serverUrl,
  token,
}) => {
  const workspaceId = await getFirstWorkspaceId(serverUrl, token);
  const agents = (await (
    await fetch(`${serverUrl}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        workspaceId,
        agentId: agents[0].id,
        title: "Screenshot upload chat",
      }),
    })
  ).json()) as { id: string };

  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByText("Screenshot upload chat").first().click();
  await page.waitForLoadState("networkidle");

  // Drop into the outer chat-pane dropzone — this is what a real drag
  // onto the conversation hits. It must NOT issue an upload request;
  // the file rides on the next /messages POST.
  await page
    .locator('[data-testid="dropzone-file-input"]')
    .first()
    .setInputFiles({
      name: SCREENSHOT_NAME,
      mimeType: "image/png",
      buffer: PNG_BYTES,
    });

  await expect(page.getByText(`Upload failed: ${SCREENSHOT_NAME}`)).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: `Remove ${SCREENSHOT_NAME}` }),
  ).toBeVisible({ timeout: 5_000 });

  // Capture the outgoing message — it must be multipart (Content-Type
  // starts with multipart/form-data) and include the file part.
  const messagePromise = page.waitForRequest(
    (req) =>
      req.method() === "POST" &&
      req.url().endsWith(`/chats/${chat.id}/messages`),
  );

  await page
    .getByPlaceholder(/continue the conversation|ask anything/i)
    .first()
    .fill("look at this");
  await page.keyboard.press("Enter");

  const sent = await messagePromise;
  const ct = sent.headers()["content-type"] ?? "";
  expect(ct.toLowerCase()).toContain("multipart/form-data");

  // The server-side outcome is what we actually assert on: the message
  // row carries the attachment, and the file lives under
  // `.chats/{id}/attachments/{name}`.
  await expect
    .poll(
      async () => {
        const res = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const { items } = (await res.json()) as {
          items: Array<{
            role: string;
            content: { type: string; text?: string };
            attachments?: Array<{ path: string; name: string }>;
          }>;
        };
        const userMsg = items.find(
          (m) =>
            m.role === "user" &&
            m.content.type === "text" &&
            m.content.text === "look at this",
        );
        return userMsg?.attachments?.map((a) => a.name) ?? [];
      },
      { timeout: 10_000 },
    )
    .toContain(SCREENSHOT_NAME);

  const messages = (await (
    await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as {
    items: Array<{
      id: string;
      role: string;
      content: { type: string; text?: string };
      attachments?: Array<{ path: string; name: string }>;
    }>;
  };
  const userMsg = messages.items.find(
    (m) =>
      m.role === "user" &&
      m.content.type === "text" &&
      m.content.text === "look at this",
  );
  expect(userMsg).toBeDefined();
  const att = userMsg!.attachments!.find((a) => a.name === SCREENSHOT_NAME);
  expect(att).toBeDefined();
  expect(att!.path).toBe(`.chats/${chat.id}/attachments/${SCREENSHOT_NAME}`);

  // Composer chip clears after send.
  await expect(
    page.getByRole("button", { name: `Remove ${SCREENSHOT_NAME}` }),
  ).not.toBeVisible();
});

test("chat: drop multiple files + caption → one message bubble with N attachments", async ({
  loggedInPage: page,
  serverUrl,
  token,
}) => {
  const workspaceId = await getFirstWorkspaceId(serverUrl, token);
  const agents = (await (
    await fetch(`${serverUrl}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        workspaceId,
        agentId: agents[0].id,
        title: "Multi-attach chat",
      }),
    })
  ).json()) as { id: string };

  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByText("Multi-attach chat").first().click();
  await page.waitForLoadState("networkidle");

  const fileNames = ["one.png", "two.png", "three.png"];
  await page
    .locator('[data-testid="dropzone-file-input"]')
    .first()
    .setInputFiles(
      fileNames.map((name) => ({
        name,
        mimeType: "image/png",
        buffer: PNG_BYTES,
      })),
    );

  for (const name of fileNames) {
    await expect(
      page.getByRole("button", { name: `Remove ${name}` }),
    ).toBeVisible({ timeout: 5_000 });
  }

  await page
    .getByPlaceholder(/continue the conversation|ask anything/i)
    .first()
    .fill("here are three screenshots");
  await page.keyboard.press("Enter");

  await expect
    .poll(
      async () => {
        const res = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const { items } = (await res.json()) as {
          items: Array<{
            role: string;
            content: { type: string; text?: string };
            attachments?: Array<{ name: string }>;
          }>;
        };
        const m = items.find(
          (x) =>
            x.role === "user" &&
            x.content.type === "text" &&
            x.content.text === "here are three screenshots",
        );
        return (m?.attachments ?? []).map((a) => a.name).sort();
      },
      { timeout: 10_000 },
    )
    .toEqual(["one.png", "three.png", "two.png"]);
});

test("new-chat: drop a file before first message → first message carries it", async ({
  loggedInPage: page,
  serverUrl,
  token,
}) => {
  const fileName = `new-chat-upload-${Date.now()}.png`;

  await page.getByRole("button", { name: /^New chat$/i }).first().click();
  await page.waitForLoadState("networkidle");

  await page
    .locator('[data-testid="dropzone-file-input"]')
    .first()
    .setInputFiles({
      name: fileName,
      mimeType: "image/png",
      buffer: PNG_BYTES,
    });

  // No "Send your first message before adding files" toast — the new
  // contract permits drops on the new-chat stub.
  await expect(
    page.getByText(/send your first message before adding files/i),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: `Remove ${fileName}` }),
  ).toBeVisible({ timeout: 5_000 });

  const chatCreatePromise = page.waitForResponse(
    (res) =>
      res.request().method() === "POST" &&
      res.url().endsWith("/chats") &&
      res.status() === 201,
  );
  const messagePromise = page.waitForRequest(
    (req) =>
      req.method() === "POST" &&
      /\/chats\/[^/]+\/messages$/.test(req.url()),
  );

  await page
    .getByPlaceholder(/ask anything|continue the conversation/i)
    .first()
    .fill("first message with a screenshot");
  await page.keyboard.press("Enter");

  const created = (await (await chatCreatePromise).json()) as { id: string };
  const sent = await messagePromise;
  expect(sent.url()).toContain(`/chats/${created.id}/messages`);
  const ct = sent.headers()["content-type"] ?? "";
  expect(ct.toLowerCase()).toContain("multipart/form-data");

  await expect
    .poll(
      async () => {
        const res = await fetch(`${serverUrl}/chats/${created.id}/messages`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const { items } = (await res.json()) as {
          items: Array<{
            role: string;
            content: { type: string; text?: string };
            attachments?: Array<{ name: string }>;
          }>;
        };
        const m = items.find(
          (x) =>
            x.role === "user" &&
            x.content.type === "text" &&
            x.content.text === "first message with a screenshot",
        );
        return (m?.attachments ?? []).map((a) => a.name);
      },
      { timeout: 10_000 },
    )
    .toContain(fileName);
});
