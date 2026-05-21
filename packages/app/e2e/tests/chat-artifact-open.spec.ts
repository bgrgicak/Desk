/**
 * Clicking a file or artifact in the Artifacts panel should open it in the
 * detail view, not stage it for attachment to the next message.
 *
 * The old behaviour was single-click → stage (debounced 250 ms), double-click
 * → open. The new behaviour is single-click → open; the paperclip icon in the
 * hover row still stages.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, expect } from "../fixtures";

interface Workspace {
  id: string;
  path: string;
}

interface Agent {
  id: string;
}

interface Chat {
  id: string;
  workspaceId: string;
}

interface Message {
  id: string;
  parentId?: string | null;
  role?: string;
  state?: string;
}

test("clicking a chat artifact file opens it in the detail view", async ({
  loggedInPage: page,
  serverUrl,
  serverHome,
  token,
}) => {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const workspaces = (await (
    await fetch(`${serverUrl}/workspaces`, { headers })
  ).json()) as Workspace[];
  const ws = workspaces[0];

  const agents = (await (
    await fetch(`${serverUrl}/agents`, { headers })
  ).json()) as Agent[];

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: ws.id,
        agentId: agents[0].id,
        title: `Artifact open test ${Date.now()}`,
      }),
    })
  ).json()) as Chat;

  // Write the artifact and attach it via an artifactRef message. listAttachments
  // only surfaces files referenced by such a message (see `attachedArtifactPaths`
  // in packages/server/api/src/routes/chats.ts). The PATCH-an-agent-reply trick
  // matches what chat-artifact-inline-preview.spec.ts uses.
  const artifactDir = path.join(
    serverHome,
    ws.path,
    ".chats",
    chat.id,
    "artifacts",
  );
  await fs.mkdir(artifactDir, { recursive: true });
  const artifactName = `e2e-artifact-${Date.now()}.md`;
  const artifactRelPath = `.chats/${chat.id}/artifacts/${artifactName}`;
  await fs.writeFile(
    path.join(artifactDir, artifactName),
    "# E2E test artifact\nHello from e2e.",
    "utf-8",
  );

  const seed = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers,
    // Keep the seed content free of the artifact filename so the test's
    // `getByText` only matches the panel entry, not this user message bubble.
    body: JSON.stringify({ content: "seed for artifact attach" }),
  });
  expect(seed.status).toBe(201);
  const userMessage = (await seed.json()) as Message;

  let target: Message | undefined;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const messages = (await (
      await fetch(`${serverUrl}/chats/${chat.id}/messages`, { headers })
    ).json()) as { items: Message[] };
    target = messages.items.find(message =>
      message.role !== "user"
      && message.parentId === userMessage.id
      && (message.state === undefined || message.state === "succeeded" || message.state === "failed")
    );
    if (target) break;
    await page.waitForTimeout(100);
  }
  if (!target) throw new Error("No agent message available to patch with an artifactRef");

  const patch = await fetch(`${serverUrl}/chats/${chat.id}/messages/${target.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      content: {
        type: "artifactRef",
        path: artifactRelPath,
        workspaceId: ws.id,
        name: artifactName,
        mime: "text/markdown",
      },
    }),
  });
  expect(patch.status).toBe(200);

  // Navigate to the chat. Wait for the avatar to confirm the app is fully
  // bootstrapped before looking for the chat in the sidebar.
  await page.reload();
  await expect(page.getByTestId("account-avatar")).toBeVisible({
    timeout: 10_000,
  });
  const chatButton = page
    .getByRole("link", { name: /Artifact open test/ })
    .first();
  await expect(chatButton).toBeVisible({ timeout: 10_000 });
  await chatButton.click();

  // The right panel renders the file row as a Link whose accessible
  // name is the filename. The previous aria-label="Open <name>" wrapper
  // went away with the panel redesign — pick the link directly.
  const panelEntry = page.getByRole("link", { name: artifactName }).first();
  await expect(panelEntry).toBeVisible({ timeout: 10_000 });

  // Single-click the file row — the new behaviour navigates to the
  // context/library view with this artifact selected (see ArtifactsPanel in
  // ChatView.tsx). The kebab menu rendered by ContextDetail confirms the
  // detail pane opened.
  await panelEntry.click();
  await page.waitForURL(/\/context\?[^/]*\bitem=/, { timeout: 5_000 });
  await expect(page.getByTestId("library-detail-more")).toBeVisible({
    timeout: 5_000,
  });
});
