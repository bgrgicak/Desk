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

test("library upload via 'Choose file' button uploads to the server", async ({
  loggedInPage: page,
}) => {
  await page.getByRole("button", { name: /^Library$/ }).first().click();
  await page.waitForLoadState("networkidle");

  // The empty-state "Add" button is the one in view when nothing has been
  // uploaded yet. On fresh e2e user it's the only one.
  const addBtn = page.getByRole("button", { name: /^Add$/ }).first();
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

test("chat Files-tab upload stages the file and the next message attaches it", async ({
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
  // wrapper and the inner FilesPanel. Either one is fine for this
  // assertion: dropping/uploading anywhere on the chat must land in
  // `.chats/{id}/attachments/`, never the workspace library.
  const inputs = page.locator('[data-testid="dropzone-file-input"]');
  await expect(inputs).toHaveCount(2);
  await inputs.last().setInputFiles({
    name: "files-tab-upload.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("hello from files-tab\n"),
  });

  // Wait for the file to surface as a chip in the composer — both
  // pendingUploads and stagedFiles render there, so this works regardless
  // of which dropzone the input was attached to.
  await expect(
    page.getByRole("button", { name: "Remove files-tab-upload.md" }),
  ).toBeVisible();

  // File must land in `.chats/{chatId}/attachments/` (chat-scoped, not
  // the workspace library).
  const expectedPath = `.chats/${chat.id}/attachments/files-tab-upload.md`;

  const chatFilesRes = await fetch(
    `${serverUrl}/chats/${chat.id}/attachments`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const chatFiles = (await chatFilesRes.json()) as Array<{
    path: string;
    name: string;
    kind: "attachment" | "note";
  }>;
  expect(chatFiles.map((i) => i.path)).toContain(expectedPath);
  expect(chatFiles.find((i) => i.path === expectedPath)?.kind).toBe(
    "attachment",
  );

  // Critical regression guard: Files-tab uploads must NOT spill into the
  // workspace library. (Prior behavior staged via /library; current
  // contract is chat-scoped.)
  const libRes = await fetch(
    `${serverUrl}/library?workspaceId=${encodeURIComponent(workspaceId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const lib = (await libRes.json()) as { items: Array<{ name: string }> };
  expect(lib.items.map((i) => i.name)).not.toContain("files-tab-upload.md");

  // Send a message — the regression we're guarding against is "file
  // uploaded but never attached, so the LLM never sees it". The POST body
  // must carry attachments[] referencing the staged file's chat path.
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
  expect(body.attachments?.map((a) => a.name)).toContain("files-tab-upload.md");
  expect(body.attachments?.map((a) => a.path)).toContain(expectedPath);

  // The "In this chat" section keeps the file visible after send.
  await expect(page.getByText("In this chat").first()).toBeVisible();
  await expect(
    page.getByText("files-tab-upload.md").first(),
  ).toBeVisible();
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

test("drop-zone overlay appears while files are being dragged", async ({
  loggedInPage: page,
}) => {
  await page.getByRole("button", { name: /^Library$/ }).first().click();
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
