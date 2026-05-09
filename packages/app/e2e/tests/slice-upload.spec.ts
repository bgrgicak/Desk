/**
 * Upload support — the "Choose file" button in the Library and the
 * "Upload a file…" button in the chat attach menu both use a hidden
 * file input. The drop-zone overlay exercises the same onFiles path.
 *
 * We test the click-path here (deterministic across browsers). The
 * DataTransfer-based drop-path is covered by a unit test on the
 * FileDropZone component in the next block — Playwright's synthetic
 * DataTransfer handling is flaky enough that a JSDOM-level test
 * catches regressions more reliably.
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";

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

async function fillComposer(page: Page, text: string) {
  const chatInput = page
    .getByPlaceholder(/ask anything|continue the conversation/i)
    .first();
  await expect(chatInput).toBeEditable();

  // The new-chat stub can remount once after a library item is staged via
  // "Use in chat". Retry the fill until React's controlled value sticks.
  for (let attempt = 0; attempt < 3; attempt++) {
    await chatInput.fill(text);
    await page.waitForTimeout(100);
    if ((await chatInput.inputValue()) === text) return chatInput;
  }

  await expect(chatInput).toHaveValue(text);
  return chatInput;
}

test("library upload via 'Choose file' button uploads to the server", async ({
  loggedInPage: page,
}) => {
  await page.getByRole("link", { name: /^Library$/ }).first().click();
  await page.waitForLoadState("networkidle");

  const addBtn = page.locator('[data-testid="library-upload-button"]').first();
  await addBtn.click();

  // File input lives beside the dropdown-menu item with this testid.
  const fileInput = page.locator('[data-testid="dropzone-file-input"]').first();
  const payload = Buffer.from("hello from click-upload\n", "utf8");
  await fileInput.setInputFiles({
    name: "library-click-upload.md",
    mimeType: "text/markdown",
    buffer: payload,
  });

  // Server round-trip + RTK Query tag invalidation → list re-fetch.
  await expect(
    page.getByText(/library-click-upload\.md/).first(),
  ).toBeVisible({ timeout: 10_000 });
});

test("chat Files-tab upload chips the file and the next message attaches it", async ({
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
        title: "Upload spec chat",
      }),
    })
  ).json()) as { id: string };

  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByText("Upload spec chat").first().click();
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Files", exact: true }).click();

  // Two FileDropZones mount on the Files tab — the outer ChatView
  // wrapper and the inner FilesPanel. Either one is fine: drops are
  // held in browser memory until send, so neither one writes to disk
  // up front.
  const inputs = page.locator('[data-testid="dropzone-file-input"]');
  await expect(inputs).toHaveCount(2);
  await inputs.last().setInputFiles({
    name: "files-tab-upload.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("hello from files-tab\n"),
  });

  await expect(
    page.getByRole("button", { name: "Remove files-tab-upload.md" }),
  ).toBeVisible();

  // No spill into the workspace library before send (the file is
  // in-memory; nothing has touched the disk yet).
  const libBefore = (await (
    await fetch(
      `${serverUrl}/library?workspaceId=${encodeURIComponent(workspaceId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
  ).json()) as { items: Array<{ name: string }> };
  expect(libBefore.items.map((i) => i.name)).not.toContain("files-tab-upload.md");

  // Send the message — the request must be multipart, with the file
  // riding as a part. The server writes it under
  // `.chats/{id}/messages/{msgId}/{name}` and stamps the AttachmentRef
  // onto the user message.
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
  expect((sent.headers()["content-type"] ?? "").toLowerCase()).toContain(
    "multipart/form-data",
  );

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
        const m = items.find(
          (x) =>
            x.role === "user" &&
            x.content.type === "text" &&
            x.content.text === "look at this",
        );
        return (m?.attachments ?? []).map((a) => a.name);
      },
      { timeout: 10_000 },
    )
    .toContain("files-tab-upload.md");

  // Still no spill into the workspace library after send.
  const libAfter = (await (
    await fetch(
      `${serverUrl}/library?workspaceId=${encodeURIComponent(workspaceId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
  ).json()) as { items: Array<{ name: string }> };
  expect(libAfter.items.map((i) => i.name)).not.toContain("files-tab-upload.md");
});

test("uploads on the new-chat screen are held until send — never spill into the library", async ({
  loggedInPage: page,
  serverUrl,
  token,
}) => {
  const workspaceId = await getFirstWorkspaceId(serverUrl, token);

  // Snapshot the workspace library — drops on the new-chat stub are
  // held in browser memory and ride on the first /messages POST, so
  // nothing new must sneak into the library before OR after send.
  const libBefore = (await (
    await fetch(
      `${serverUrl}/library?workspaceId=${encodeURIComponent(workspaceId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
  ).json()) as { items: Array<{ name: string }> };
  const namesBefore = new Set(libBefore.items.map((i) => i.name));

  await page.getByRole("link", { name: /^New chat$/i }).first().click();
  await page.waitForLoadState("networkidle");

  const outerInput = page.locator('[data-testid="dropzone-file-input"]').first();
  const guardFileName = `new-chat-no-spill-${Date.now()}.md`;
  await outerInput.setInputFiles({
    name: guardFileName,
    mimeType: "text/markdown",
    buffer: Buffer.from("must not land in library\n"),
  });

  // The chip appears (file is held in composer state), and there is
  // NO upload-rejection toast — the new contract permits drops here.
  await expect(
    page.getByRole("button", { name: `Remove ${guardFileName}` }),
  ).toBeVisible({ timeout: 5_000 });
  await expect(
    page.getByText(/send your first message before adding files/i),
  ).not.toBeVisible();

  // Library snapshot before send: nothing wrote to disk yet.
  const libDuring = (await (
    await fetch(
      `${serverUrl}/library?workspaceId=${encodeURIComponent(workspaceId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
  ).json()) as { items: Array<{ name: string }> };
  const newNamesDuring = libDuring.items
    .map((i) => i.name)
    .filter((n) => !namesBefore.has(n));
  expect(newNamesDuring).not.toContain(guardFileName);

  // Send the first message — file rides as multipart, lands under
  // `.chats/{id}/messages/{msgId}/{name}`, never the workspace root.
  await page
    .getByPlaceholder(/ask anything|continue the conversation/i)
    .first()
    .fill("first message");
  await page.keyboard.press("Enter");

  await expect.poll(async () => {
    const res = await fetch(
      `${serverUrl}/library?workspaceId=${encodeURIComponent(workspaceId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const lib = (await res.json()) as { items: Array<{ name: string }> };
    return lib.items.map((i) => i.name).filter((n) => !namesBefore.has(n));
  }, { timeout: 5_000 }).not.toContain(guardFileName);
});

test("attach picker mentions a library file and the next message attaches it", async ({
  loggedInPage: page,
  serverUrl,
  token,
  request,
}) => {
  const workspaceId = await getFirstWorkspaceId(serverUrl, token);
  const agents = (await (
    await fetch(`${serverUrl}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  // Seed a library file so the attach picker has something to mention.
  const fileName = "library-mention-target.md";
  const upload = await request.post(
    `${serverUrl}/library?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: {
          name: fileName,
          mimeType: "text/markdown",
          buffer: Buffer.from("hello mention\n"),
        },
      },
    },
  );
  expect(upload.status()).toBe(201);

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
        title: "Mention spec chat",
      }),
    })
  ).json()) as { id: string };

  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByText("Mention spec chat").first().click();
  await page.waitForLoadState("networkidle");

  // Open the attach picker below the message input and pick the seeded file.
  await page.getByRole("button", { name: /^Add files$/ }).click();
  const uploadButton = page.getByTestId("chat-upload-a-file");
  const seededFileButton = page.getByRole("button", { name: fileName });
  await expect(uploadButton).toBeVisible();
  await expect(seededFileButton).toBeVisible();
  const uploadBox = await uploadButton.boundingBox();
  const seededFileBox = await seededFileButton.boundingBox();
  expect(uploadBox).not.toBeNull();
  expect(seededFileBox).not.toBeNull();
  expect(uploadBox!.y).toBeLessThan(seededFileBox!.y);
  await page.getByRole("button", { name: fileName }).click();

  // Regression: library mentions were filtered out in ChatInput.handleSubmit
  // before reaching onSend, so attachments[] arrived empty on the wire.
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
  const body = JSON.parse(sent.postData() ?? "{}") as {
    attachments?: Array<{ path: string; name: string }>;
  };
  expect(body.attachments?.map((a) => a.name)).toContain(fileName);
  expect(body.attachments?.map((a) => a.path)).toContain(fileName);
});

test("first message in a new chat carries @-mentioned library file", async ({
  loggedInPage: page,
  serverUrl,
  token,
  request,
}) => {
  const workspaceId = await getFirstWorkspaceId(serverUrl, token);

  // Seed a uniquely-named library file so the attach picker has something
  // to mention. Uniqueness lets us assert against the file regardless of
  // what the seed user's library already holds.
  const fileName = `new-chat-mention-${Date.now()}.md`;
  const upload = await request.post(
    `${serverUrl}/library?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: {
          name: fileName,
          mimeType: "text/markdown",
          buffer: Buffer.from("first-message attachment target\n"),
        },
      },
    },
  );
  expect(upload.status()).toBe(201);
  await page.reload();
  await page.waitForLoadState("networkidle");

  // Open the new-chat screen — no chat row exists yet, so the first send
  // path runs createChat → POST /chats/:id/messages back-to-back. The
  // regression: the new-chat branch in ChatView dropped the uploads arg
  // when calling onFirstMessage, so attachments[] never reached the wire
  // for the first message even though the picker recorded the mention.
  await page.getByRole("link", { name: /^New chat$/i }).first().click();
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: /^Add files$/ }).click();
  await page.getByRole("button", { name: fileName }).click();

  // Capture the create-chat POST so we can address the message POST by
  // its concrete chat id (the route is /chats/<id>/messages, and we want
  // to fail loudly if the first /messages POST is for a *different* chat
  // than the one we just created).
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
    .fill("look at this on the very first message");
  await page.keyboard.press("Enter");

  const created = (await (await chatCreatePromise).json()) as { id: string };
  const sent = await messagePromise;
  expect(sent.url()).toContain(`/chats/${created.id}/messages`);

  const body = JSON.parse(sent.postData() ?? "{}") as {
    content: string;
    attachments?: Array<{ path: string; name: string }>;
  };
  expect(body.content).toContain("very first message");
  expect(body.attachments?.map((a) => a.name)).toContain(fileName);
  expect(body.attachments?.map((a) => a.path)).toContain(fileName);
});

test("attach picker mentions a library folder and the next message attaches the directory", async ({
  loggedInPage: page,
  serverUrl,
  token,
  request,
}) => {
  const workspaceId = await getFirstWorkspaceId(serverUrl, token);
  const agents = (await (
    await fetch(`${serverUrl}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  // Seed a library folder so the attach picker has a directory to mention.
  const folderName = `mention-folder-${Date.now()}`;
  const folderRes = await request.post(
    `${serverUrl}/library/folder?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: { path: folderName },
    },
  );
  expect(folderRes.status()).toBe(201);

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
        title: "Folder mention chat",
      }),
    })
  ).json()) as { id: string };

  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByText("Folder mention chat").first().click();
  await page.waitForLoadState("networkidle");

  // Open the attach picker and pick the seeded folder. Folder rows render
  // with a folder icon but the same accessible name as files.
  await page.getByRole("button", { name: /^Add files$/ }).click();
  await page.getByRole("button", { name: folderName }).click();

  // Regression: ChatInput.handleSubmit used to filter out folder mentions
  // before reaching onSend, so directory attachments never made it on the
  // wire and opencode never saw the folder.
  const messagePromise = page.waitForRequest(
    (req) =>
      req.method() === "POST" &&
      req.url().endsWith(`/chats/${chat.id}/messages`),
  );
  await page
    .getByPlaceholder(/continue the conversation|ask anything/i)
    .first()
    .fill("look in this folder");
  await page.keyboard.press("Enter");
  const sent = await messagePromise;
  const body = JSON.parse(sent.postData() ?? "{}") as {
    attachments?: Array<{ path: string; name: string; kind?: string }>;
  };
  expect(body.attachments?.map((a) => a.name)).toContain(folderName);
  expect(body.attachments?.map((a) => a.path)).toContain(folderName);
  // The `kind` discriminator is what makes the message-bubble chip render
  // a folder icon and route clicks to the folder view instead of the file
  // detail view — it must be present on the wire.
  expect(body.attachments?.find((a) => a.path === folderName)?.kind).toBe(
    "directory",
  );
});

test("library detail's 'Use in chat' pins the file to chat attachments without adding it as a message attachment", async ({
  loggedInPage: page,
  serverUrl,
  token,
  request,
}) => {
  const workspaceId = await getFirstWorkspaceId(serverUrl, token);

  const fileName = `use-in-chat-${Date.now()}.md`;
  const upload = await request.post(
    `${serverUrl}/library?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: {
          name: fileName,
          mimeType: "text/markdown",
          buffer: Buffer.from("use-in-chat target body\n"),
        },
      },
    },
  );
  expect(upload.status()).toBe(201);
  await page.reload();
  await page.waitForLoadState("networkidle");

  await page.getByRole("link", { name: /^Library$/ }).first().click();
  await page.waitForLoadState("networkidle");
  await page.getByText(fileName, { exact: true }).first().click();
  await page.waitForLoadState("networkidle");

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
  const pinPromise = page.waitForRequest(
    (req) =>
      req.method() === "POST" &&
      /\/chats\/[^/]+\/library-refs$/.test(req.url()),
  );

  await page.locator('[data-testid="library-detail-more"]').first().click();
  await page.getByRole("menuitem", { name: /Use in chat/ }).first().click();

  // Wait for navigation to the new-chat stub and for the workspace
  // agents query to settle before interacting.
  await page.waitForURL(/chat=new/, { timeout: 10_000 });
  await page.waitForLoadState("networkidle");

  // The file must NOT appear as a chip in the message input tray.
  // "Use in chat" links files to chat attachments, not message attachments.
  await expect(
    page.getByRole("button", { name: `Remove ${fileName}` }),
  ).not.toBeVisible();

  const chatInput = await fillComposer(page, "look at the summary I just opened");
  // Use locator.press rather than page.keyboard.press so the Enter event
  // is always dispatched to the textarea even if focus shifted during the
  // preceding animation or re-render.
  await chatInput.press("Enter");

  const created = (await (await chatCreatePromise).json()) as { id: string };
  const sent = await messagePromise;
  expect(sent.url()).toContain(`/chats/${created.id}/messages`);

  // The file must NOT be sent as a message attachment.
  const body = JSON.parse(sent.postData() ?? "{}") as {
    content: string;
    attachments?: Array<{ path: string; name: string }>;
  };
  const attachedNames = body.attachments?.map((a) => a.name) ?? [];
  expect(attachedNames).not.toContain(fileName);

  // The file must be pinned via library-refs so it appears in the
  // right-sidebar "In this chat" list.
  const pinReq = await pinPromise;
  expect(pinReq.url()).toContain(`/chats/${created.id}/library-refs`);
  const pinBody = JSON.parse(pinReq.postData() ?? "{}") as { path: string };
  expect(pinBody.path).toBe(fileName);

  // Poll until the symlink lands in `.chats/{chatId}/attachments/`.
  const expectedPinnedPath = `.chats/${created.id}/attachments/${fileName}`;
  await expect
    .poll(
      async () => {
        const res = await fetch(
          `${serverUrl}/chats/${created.id}/attachments`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const list = (await res.json()) as Array<{ path: string }>;
        return list.map((i) => i.path);
      },
      { timeout: 10_000 },
    )
    .toContain(expectedPinnedPath);
});

test("clicking a pending 'Use in chat' file in the Files sidebar opens its library detail", async ({
  loggedInPage: page,
  serverUrl,
  token,
  request,
}) => {
  const workspaceId = await getFirstWorkspaceId(serverUrl, token);

  const fileName = `sidebar-click-${Date.now()}.md`;
  const upload = await request.post(
    `${serverUrl}/library?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: {
          name: fileName,
          mimeType: "text/markdown",
          buffer: Buffer.from("# Click test\n\nContent here.\n"),
        },
      },
    },
  );
  expect(upload.status()).toBe(201);
  await page.reload();
  await page.waitForLoadState("networkidle");

  // Open Library, find and open the file's detail view
  await page.getByRole("link", { name: /^Library$/ }).first().click();
  await page.waitForLoadState("networkidle");
  await page.getByText(fileName, { exact: true }).first().click();
  await page.waitForLoadState("networkidle");

  // Use "Use in chat" to add as a chat attachment (not message attachment)
  await page.locator('[data-testid="library-detail-more"]').first().click();
  await page.getByRole("menuitem", { name: /Use in chat/ }).first().click();

  await page.waitForURL(/chat=new/, { timeout: 10_000 });
  await page.waitForLoadState("networkidle");

  // Switch to the "Files" tab in the right panel and click the pending file
  await page.getByRole("button", { name: /^Files$/ }).first().click();
  await page.getByText(fileName, { exact: true }).first().click();

  // Must navigate to the library context view showing the file's detail,
  // not to the parent folder.
  await page.waitForURL((url) => url.searchParams.has("item"), {
    timeout: 10_000,
  });
  const url = new URL(page.url());
  expect(url.pathname).toContain("/context");
  expect(url.searchParams.get("item")).toBe(fileName);
});

test("drop-zone overlay appears while files are being dragged", async ({
  loggedInPage: page,
}) => {
  await page.getByRole("link", { name: /^Library$/ }).first().click();
  await page.waitForLoadState("networkidle");

  // Dispatch a real DragEvent with Files type to the ContextList drop zone.
  // We can't drop a real File via Playwright without a DataTransfer
  // constructor, but we can verify the overlay shows on dragenter.
  const zone = page.locator("[data-dropzone]").first();
  await zone.evaluate((el) => {
    const ev = new DragEvent("dragenter", {
      bubbles: true,
      cancelable: true,
      dataTransfer: new DataTransfer(),
    });
    // DataTransfer.items read-only mutation is inconsistent; mock the
    // types array instead via a manual dataTransfer-like payload.
    Object.defineProperty(ev, "dataTransfer", {
      value: { types: ["Files"], items: [] },
    });
    el.dispatchEvent(ev);
  });

  await expect(zone).toHaveAttribute("data-dragging", "true");
  await expect(page.getByText(/drop to add to library/i)).toBeVisible();
});
