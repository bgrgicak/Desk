/**
 * Slice 7 — Library list backed by GET /library.
 *
 * Uploads a file to the active workspace via multipart POST and then
 * opens the Library view to confirm it surfaces.
 */
import { test, expect } from "../fixtures";

async function uploadLibraryFile(
  serverUrl: string,
  token: string,
  workspaceId: string,
  name: string,
  body: string,
): Promise<void> {
  const boundary = `----desk-e2e-${Math.random().toString(16).slice(2)}`;
  const bodyBuf = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        `Content-Type: text/markdown\r\n\r\n`,
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
        "Content-Length": String(bodyBuf.length),
      },
      body: bodyBuf,
    },
  );
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
}

test("uploaded file shows up in the library view", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  await uploadLibraryFile(
    serverUrl,
    token,
    ws[0].id,
    "slice7-ping.md",
    "# slice7 ping\n\nhello from the library spec.\n",
  );

  await loggedInPage.reload();

  // Navigate to the Library sidebar entry.
  await loggedInPage.getByRole("link", { name: /^Library$/ }).first().click();

  await expect(
    loggedInPage.getByText(/slice7-ping\.md/).first(),
  ).toBeVisible({ timeout: 10_000 });
});

test("deleting a library item removes it from the list", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const filename = `slice7-delete-${Date.now()}.md`;
  await uploadLibraryFile(
    serverUrl,
    token,
    ws[0].id,
    filename,
    "# delete me\n",
  );

  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Library$/ }).first().click();

  await expect(loggedInPage.getByText(filename).first()).toBeVisible({
    timeout: 10_000,
  });

  await loggedInPage
    .getByTestId(`library-item-menu-${filename}`)
    .click();
  await loggedInPage.getByRole("menuitem", { name: /^Delete$/ }).click();
  await loggedInPage.getByRole("button", { name: /^Delete$/ }).click();

  await expect(loggedInPage.getByText(filename)).toHaveCount(0, {
    timeout: 10_000,
  });
});

test("moves a folder (with contents) into another folder", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const stamp = Date.now();
  const src = `MoveSrc-${stamp}`;
  const dst = `MoveDst-${stamp}`;
  const inside = `inside-${stamp}.md`;

  // Create the two folders and drop a file into src.
  for (const sub of [src, dst]) {
    const res = await fetch(
      `${serverUrl}/library/folder?workspaceId=${encodeURIComponent(ws[0].id)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: sub }),
      },
    );
    expect(res.status).toBe(201);
  }
  await uploadLibraryFile(serverUrl, token, ws[0].id, inside, "payload\n");
  // Move the file from root into src so the folder has contents.
  await fetch(`${serverUrl}/library?workspaceId=${encodeURIComponent(ws[0].id)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: inside, to: `${src}/${inside}` }),
  });

  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Library$/ }).first().click();

  // Open the src folder's row menu → "Move to folder" → pick dst.
  const srcRow = loggedInPage.getByText(src, { exact: true }).first();
  await expect(srcRow).toBeVisible({ timeout: 10_000 });
  await srcRow.hover();
  // The row's ... button is the last button sibling; dropdown-triggers
  // render as buttons, so .last() targets the More menu.
  const row = srcRow.locator("xpath=ancestor::*[contains(@class,'group')][1]");
  await row.getByRole("button").last().click();
  await loggedInPage.getByRole("menuitem", { name: /^Move to folder$/ }).click();
  await loggedInPage.getByRole("button", { name: new RegExp(`^${dst}$`) }).click();

  // src should now live under dst. The library list is folder-scoped:
  // the root view stops showing `src` once the move lands, and clicking
  // into `dst` reveals it nested there. Verify via the server (the
  // listing endpoint is the source of truth that the dialog drives) so
  // the test doesn't have to know the exact folder-row markup.
  await expect.poll(async () => {
    const res = await fetch(
      `${serverUrl}/library?workspaceId=${encodeURIComponent(ws[0].id)}&path=${encodeURIComponent(dst)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as {
      items?: Array<{ path: string }>;
      folders?: Array<{ path: string }>;
    };
    return [
      ...(body.items ?? []).map((i) => i.path),
      ...(body.folders ?? []).map((f) => f.path),
    ];
  }, { timeout: 10_000 }).toContain(`${dst}/${src}`);
});
