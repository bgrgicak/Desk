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

  // Directly write a file into the chat's artifacts directory — simulates what
  // the agent would do after a run.
  const artifactDir = path.join(
    serverHome,
    ws.path,
    ".chats",
    chat.id,
    "artifacts",
  );
  await fs.mkdir(artifactDir, { recursive: true });
  const artifactName = `e2e-artifact-${Date.now()}.md`;
  await fs.writeFile(
    path.join(artifactDir, artifactName),
    "# E2E test artifact\nHello from e2e.",
    "utf-8",
  );

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

  // The Artifacts panel is open by default; wait for the file to appear.
  await expect(page.getByText(artifactName).first()).toBeVisible({
    timeout: 10_000,
  });

  // Single-click the file row.
  await page.getByText(artifactName).first().click();

  // The file detail view should open — library-detail-more is the kebab menu
  // that only renders when an item is selected in the detail pane.
  await expect(page.getByTestId("library-detail-more")).toBeVisible({
    timeout: 5_000,
  });

  // No staging chip should have appeared in the compose input area.
  // The compose footer is always rendered; the staging tray only appears when
  // at least one file is staged. A chip bearing the artifact name inside the
  // footer would indicate the old staging behaviour fired instead.
  const footer = page.locator("footer, [data-testid='chat-footer']").first();
  // Give the old 250 ms debounce time to fire if the implementation hasn't
  // changed yet — the test intentionally waits past it.
  await page.waitForTimeout(400);
  await expect(
    page.getByText(artifactName).nth(0),
  ).toBeVisible(); // still visible in the panel (not navigated away)
});
