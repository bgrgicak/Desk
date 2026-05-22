/**
 * Slice 21 — PUT /library/content (saveLibraryContent).
 *
 * Wired in `ContextDetail` (note/text editor's save button). Verifies
 * the in-place rewrite endpoint that the editor invokes.
 */
import { test, expect } from "../fixtures";

async function uploadMarkdown(
  serverUrl: string,
  token: string,
  workspaceId: string,
  name: string,
  body: string,
): Promise<void> {
  const boundary = `----roomy-e2e-${Math.random().toString(16).slice(2)}`;
  const buf = Buffer.concat([
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
        "Content-Length": String(buf.length),
      },
      body: buf,
    },
  );
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
}

test("editing library content via PUT /library/content rewrites the file", async ({
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;
  const filename = `slice21-edit-${Date.now()}.md`;

  await uploadMarkdown(serverUrl, token, ws[0].id, filename, "# original\n");

  const newContent = "# rewritten\n\nslice21 was here.\n";
  const put = await fetch(
    `${serverUrl}/library/content?workspaceId=${encodeURIComponent(ws[0].id)}&path=${encodeURIComponent(filename)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/markdown",
      },
      body: newContent,
    },
  );
  expect(put.status).toBeGreaterThanOrEqual(200);
  expect(put.status).toBeLessThan(300);

  const fetched = await fetch(
    `${serverUrl}/library/content?workspaceId=${encodeURIComponent(ws[0].id)}&path=${encodeURIComponent(filename)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(fetched.status).toBe(200);
  expect(await fetched.text()).toBe(newContent);
});
