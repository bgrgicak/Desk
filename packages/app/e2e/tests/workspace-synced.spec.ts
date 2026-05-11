/**
 * workspace.synced — when an agent run completes the server pushes a
 * `workspace.synced` WS event. The browser must re-fetch the currently-open
 * library file and refresh the editor even though the file was written
 * directly to disk (not via the REST API, so no `library.changed` fires).
 *
 * Pipeline under test:
 *   agent writes file to disk (bypasses REST)
 *   → scheduled task completes (fake driver)
 *   → scheduler emits `workspace.synced`
 *   → WS middleware → derivedSlice.bumpWorkspaceChangeCounter
 *   → ContextDetail useEffect re-runs → fetchLibraryContent → editor updates
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, expect } from "../fixtures";

type Workspace = { id: string; path: string };
type Agent = { id: string };

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
        `Content-Type: application/json\r\n\r\n`,
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
  await page.getByRole("link", { name: /^Library$/ }).first().click();
  const row = page.getByText(filename).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(page.getByTestId("library-detail-more")).toBeVisible({ timeout: 10_000 });
}

async function fireScheduledTask(
  serverUrl: string,
  token: string,
  workspaceId: string,
  agentId: string,
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId, agentId, title: "ws-synced-e2e" }),
    })
  ).json()) as { id: string };

  await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: "ws-synced-trigger",
      kind: "task",
      title: "ws-synced-trigger",
      executeAt: new Date(Date.now() - 1_000).toISOString(),
    }),
  });
}

test("open library file auto-refreshes after workspace.synced when agent writes file to disk", async ({
  loggedInPage,
  serverUrl,
  serverHome,
  token,
}) => {
  const workspaces = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Workspace[];
  const workspace = workspaces[0];

  const agents = (await (
    await fetch(`${serverUrl}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Agent[];
  expect(agents.length).toBeGreaterThan(0);

  const filename = `ws-synced-${Date.now()}.json`;
  const initial = "initial content before agent run\n";
  const agentWrote = `agent wrote this at ${Date.now()}\n`;

  // Upload initial content via REST API.
  const filePath = await uploadText(
    serverUrl,
    token,
    workspace.id,
    filename,
    initial,
  );

  // Open the file in the browser — starts the WS connection and loads
  // initial content into the CodeMirror editor.
  await openLibraryFile(loggedInPage, filename);
  await expect(loggedInPage.locator(".cm-content")).toContainText(
    "initial content before agent run",
  );

  // Simulate an agent writing to the file directly on disk (no REST API call,
  // so no `library.changed` event fires — only `workspace.synced` will trigger
  // a re-fetch once the scheduled task below completes).
  const absPath = path.join(
    serverHome,
    workspace.path,
    filePath,
  );
  await fs.writeFile(absPath, agentWrote, "utf8");

  // Trigger workspace.synced by scheduling a task that fires immediately.
  // The fake sandbox driver (used in e2e) completes it synchronously and the
  // scheduler emits workspace.synced after fireMessage returns.
  await fireScheduledTask(serverUrl, token, workspace.id, agents[0].id);

  // Poll until the new content appears — no page reload, no user action.
  await expect.poll(
    () => loggedInPage.locator(".cm-content").textContent(),
    {
      timeout: 15_000,
      message: "editor should auto-refresh after workspace.synced event",
    },
  ).toContain(agentWrote.trim());
});
