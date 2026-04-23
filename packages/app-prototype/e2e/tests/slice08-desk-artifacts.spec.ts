/**
 * Slice 8 — Desk grid shows artifacts persisted to the library.
 */
import { test, expect } from "../fixtures";

async function uploadToLibrary(
  serverUrl: string,
  token: string,
  workspaceId: string,
  name: string,
  mime: string,
  body: string,
): Promise<void> {
  const boundary = `----desk-e2e-${Math.random().toString(16).slice(2)}`;
  const bodyBuf = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`,
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

test("desk grid renders a library artifact", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  await uploadToLibrary(
    serverUrl,
    token,
    ws[0].id,
    "slice8-note.md",
    "text/markdown",
    "# slice 8\n\nlook, a desk artifact",
  );

  await loggedInPage.reload();

  // Desk is the default landing view.
  await expect(
    loggedInPage.getByText(/slice8-note\.md/).first(),
  ).toBeVisible({ timeout: 10_000 });
});
