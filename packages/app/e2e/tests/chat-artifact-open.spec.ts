/**
 * Clicking a file or artifact in the Artifacts panel should open it in the
 * in-chat preview side panel, not stage it for attachment to the next message
 * and not navigate away to the Library detail page.
 *
 * The old behaviour was single-click → stage (debounced 250 ms), double-click
 * → open. After PR #143 the behaviour is single-click → open the preview
 * panel (data-testid="preview-panel") while the chat thread stays mounted.
 * The paperclip icon in the hover row still stages; the kebab "Open" action
 * (used by other tests) still navigates to the full Library detail page.
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

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  const artifactCard = page
    .getByRole("button", { name: new RegExp(`^${escapeRegex(artifactName)}\\b`) })
    .first();
  await expect(artifactCard).toBeVisible({ timeout: 10_000 });

  // Single-click the file row — the new behaviour opens the in-chat
  // preview side panel (see `handleAttachmentClick` in App.tsx, which
  // dispatches `openArtifact` to the previewPanel slice). The chat thread
  // stays in place; the URL does NOT change.
  await artifactCard.click();
  const previewPanel = page.getByTestId("preview-panel");
  await expect(previewPanel).toBeVisible({ timeout: 5_000 });
  // The panel header repeats the artifact filename so we can prove the
  // right file landed in the panel — not just "any" panel that happened
  // to open.
  await expect(previewPanel.getByText(artifactName)).toBeVisible({
    timeout: 5_000,
  });
});
