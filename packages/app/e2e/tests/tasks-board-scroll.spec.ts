import { test, expect } from "../fixtures";

test("long task columns scroll inside the board", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const wsList = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;
  const agents = (await (
    await fetch(`${serverUrl}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: wsList[0].id,
        agentId: agents[0].id,
        title: "Tasks board scroll",
      }),
    })
  ).json()) as { id: string };

  const taskCreates = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      fetch(`${serverUrl}/chats/${chat.id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          content: `Scroll regression task ${String(i + 1).padStart(2, "0")}`,
          kind: "task",
          title: `Scroll regression task ${String(i + 1).padStart(2, "0")}`,
        }),
      }),
    ),
  );
  for (const res of taskCreates) {
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  }

  await loggedInPage.reload();
  await loggedInPage.getByRole("button", { name: /^Tasks$/ }).first().click();
  await expect(loggedInPage.getByText("Scroll regression task 01").first()).toBeVisible({
    timeout: 10_000,
  });

  const todoList = loggedInPage.getByTestId("tasks-column-todo-list");
  await expect(todoList).toBeVisible();

  await expect
    .poll(() =>
      todoList.evaluate(node => node.clientHeight > 0 && node.scrollHeight > node.clientHeight),
    )
    .toBe(true);

  await todoList.evaluate(node => {
    node.scrollTop = node.scrollHeight;
  });
  await expect
    .poll(() => todoList.evaluate(node => node.scrollTop))
    .toBeGreaterThan(0);
});
