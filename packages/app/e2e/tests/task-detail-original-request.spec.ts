import { test, expect } from "../fixtures";

test("task detail shows the original request before any run output", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const workspaces = (await (
    await fetch(`${serverUrl}/workspaces`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;
  const agents = (await (
    await fetch(`${serverUrl}/agents`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;
  const workspaceId = workspaces[0].id;
  const agentId = agents[0].id;

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId,
        agentId,
        title: "Task detail source",
      }),
    })
  ).json()) as { id: string };

  const request = "Let's build a news feed that can pull RSS.";
  const created = (await (
    await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: request,
        kind: "task",
        title: "Build RSS news feed",
        executeAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    })
  ).json()) as { id: string };

  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();

  const taskCard = loggedInPage.getByTestId(`task-card-${created.id}`);
  await expect(taskCard).toBeVisible({ timeout: 15_000 });
  await taskCard.click();

  const originalRequest = loggedInPage.getByTestId("task-original-request");
  await expect(originalRequest).toBeVisible({ timeout: 10_000 });
  await expect(originalRequest.getByText("Original request")).toBeVisible();
  await expect(originalRequest.getByText(request)).toBeVisible();
  await expect(loggedInPage.getByTestId("task-chat-empty")).toBeVisible();
  await expect(loggedInPage.locator(`[data-testid="task-card-${created.id}"]`)).toHaveCount(1);
});
