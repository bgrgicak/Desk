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
  await loggedInPage.getByRole("button", { name: /^Library$/ }).first().click();

  await expect(
    loggedInPage.getByText(/slice7-ping\.md/).first(),
  ).toBeVisible({ timeout: 10_000 });
});
