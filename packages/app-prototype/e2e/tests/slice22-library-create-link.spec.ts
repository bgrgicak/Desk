/**
 * Slice 22 — POST /library/link (createLibraryLink).
 *
 * Wired in `ContextList`'s "Add link" affordance. Verifies the
 * URL-shortcut endpoint that the UI invokes.
 */
import { test, expect } from "../fixtures";

test("creating a URL link adds a shortcut entry to the library listing", async ({
  serverUrl,
  token,
}) => {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;
  const linkName = `slice22-link-${Date.now()}`;

  const created = await fetch(
    `${serverUrl}/library/link?workspaceId=${encodeURIComponent(ws[0].id)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/slice22",
        name: linkName,
      }),
    },
  );
  expect(created.status).toBeGreaterThanOrEqual(200);
  expect(created.status).toBeLessThan(300);
  const file = (await created.json()) as { path: string; name: string };
  expect(file.path).toMatch(new RegExp(linkName));

  // Must show up in the library listing.
  const list = await fetch(
    `${serverUrl}/library?workspaceId=${encodeURIComponent(ws[0].id)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(list.status).toBe(200);
  const body = (await list.json()) as { items: Array<{ path: string }> };
  expect(body.items.some(i => i.path === file.path)).toBe(true);
});
