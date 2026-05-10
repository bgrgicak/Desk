/**
 * Slice 19 — drag a task between board columns triggers a PATCH that
 * survives reload. The actual mouse-drag dance is fiddly under
 * Playwright (the @dnd-kit pointer-sensor needs `move` + `move` + `up`),
 * so we exercise the underlying server contract directly: the parent
 * `onTaskMove` callback PATCHes the message; we PATCH the same way and
 * confirm the UI follows.
 */
import { test, expect } from "../fixtures";

async function cancelTaskAndRuns(serverUrl: string, token: string, chatId: string, taskId: string) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  await expect.poll(async () => {
    const runsRes = await fetch(`${serverUrl}/messages?chatId=${chatId}&kind=task_run&parentId=${taskId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const runs = (await runsRes.json()) as { items: Array<{ state?: string }> };
    return runs.items.some(run => run.state === "pending" || run.state === "running");
  }, { timeout: 30_000 }).toBe(false);

  await fetch(`${serverUrl}/chats/${chatId}/messages/${taskId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ state: "cancelled" }),
  });

  await expect.poll(async () => {
    const res = await fetch(`${serverUrl}/chats/${chatId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { items: Array<{ id: string; state?: string }> };
    return body.items.find(m => m.id === taskId)?.state;
  }, { timeout: 10_000 }).toBe("cancelled");
}

test("moving a task to the Complete column persists as cancelled", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const wsList = (await (
    await fetch(`${serverUrl}/workspaces`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;
  const agents = (await (
    await fetch(`${serverUrl}/agents`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: wsList[0].id,
        agentId: agents[0].id,
        title: "Slice19 board",
      }),
    })
  ).json()) as { id: string };

  const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const post = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: "Slice19 board card",
      kind: "task",
      title: "Slice19 board card",
      executeAt: futureIso,
    }),
  });
  const userMsg = (await post.json()) as { id: string };

  // Simulate the BoardView drop → PATCH `state: 'cancelled'` (our UI
  // mapping for the Complete column). The Tasks page should reflect
  // the row in the Complete column on next render.
  const move = await fetch(`${serverUrl}/chats/${chat.id}/messages/${userMsg.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ state: "cancelled" }),
  });
  expect(move.status).toBeGreaterThanOrEqual(200);
  expect(move.status).toBeLessThan(300);

  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();

  // Card text appears on the page.
  await expect(loggedInPage.getByText("Slice19 board card").first()).toBeVisible({
    timeout: 10_000,
  });

  // And the server confirms the post-PATCH state survived a reload round-trip.
  const recheck = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await recheck.json()) as { items: Array<{ id: string; state?: string }> };
  expect(body.items.find(m => m.id === userMsg.id)?.state).toBe("cancelled");
});

test("dragging a todo task to Active keeps the card there while the run starts", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const wsList = (await (
    await fetch(`${serverUrl}/workspaces`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;
  const agents = (await (
    await fetch(`${serverUrl}/agents`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: wsList[0].id,
        agentId: agents[0].id,
        title: "Slice19 active drag",
      }),
    })
  ).json()) as { id: string };

  const post = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: "Slice19 drag to active",
      kind: "task",
      title: "Slice19 drag to active",
    }),
  });
  const task = (await post.json()) as { id: string };

  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();

  const card = loggedInPage.getByTestId(`task-row-${task.id}`);
  const activeColumn = loggedInPage.getByTestId("tasks-column-active-list");
  await expect(card).toBeVisible({ timeout: 10_000 });

  const cardBox = await card.boundingBox();
  const activeBox = await activeColumn.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(activeBox).not.toBeNull();

  await loggedInPage.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + cardBox!.height / 2);
  await loggedInPage.mouse.down();
  await loggedInPage.mouse.move(activeBox!.x + activeBox!.width / 2, activeBox!.y + 40, { steps: 12 });
  await loggedInPage.mouse.move(activeBox!.x + activeBox!.width / 2, activeBox!.y + activeBox!.height / 2, { steps: 12 });
  await loggedInPage.mouse.up();

  await expect
    .poll(async () => {
      const res = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { items: Array<{ id: string; state?: string }> };
      return body.items.find(m => m.id === task.id)?.state;
    }, { timeout: 10_000 })
    .toBe("running");
  await expect(activeColumn.getByTestId(`task-row-${task.id}`)).toBeVisible({ timeout: 10_000 });

  await cancelTaskAndRuns(serverUrl, token, chat.id, task.id);
});

test("dragging a todo task to the Active column header still starts the run", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const wsList = (await (
    await fetch(`${serverUrl}/workspaces`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;
  const agents = (await (
    await fetch(`${serverUrl}/agents`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: wsList[0].id,
        agentId: agents[0].id,
        title: "Slice19 active drag header",
      }),
    })
  ).json()) as { id: string };

  const post = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: "Slice19 drag to active header",
      kind: "task",
      title: "Slice19 drag to active header",
    }),
  });
  const task = (await post.json()) as { id: string };

  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();

  const card = loggedInPage.getByTestId(`task-row-${task.id}`);
  const activeColumn = loggedInPage.getByTestId("tasks-column-active");
  const activeList = loggedInPage.getByTestId("tasks-column-active-list");
  await expect(card).toBeVisible({ timeout: 10_000 });

  const cardBox = await card.boundingBox();
  const activeBox = await activeColumn.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(activeBox).not.toBeNull();

  await loggedInPage.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + cardBox!.height / 2);
  await loggedInPage.mouse.down();
  await loggedInPage.mouse.move(activeBox!.x + activeBox!.width / 2, activeBox!.y + 14, { steps: 12 });
  await loggedInPage.mouse.up();

  await expect
    .poll(async () => {
      const res = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { items: Array<{ id: string; state?: string }> };
      return body.items.find(m => m.id === task.id)?.state;
    }, { timeout: 10_000 })
    .toBe("running");
  await expect(activeList.getByTestId(`task-row-${task.id}`)).toBeVisible({ timeout: 10_000 });

  await cancelTaskAndRuns(serverUrl, token, chat.id, task.id);
});

test("dragging a todo task to Active works while the task detail sidebar is open", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const wsList = (await (
    await fetch(`${serverUrl}/workspaces`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;
  const agents = (await (
    await fetch(`${serverUrl}/agents`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: wsList[0].id,
        agentId: agents[0].id,
        title: "Slice19 active drag sidebar",
      }),
    })
  ).json()) as { id: string };

  const post = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: "Slice19 drag to active with sidebar",
      kind: "task",
      title: "Slice19 drag to active with sidebar",
    }),
  });
  const task = (await post.json()) as { id: string };

  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();

  const card = loggedInPage.getByTestId(`task-row-${task.id}`);
  const activeColumn = loggedInPage.getByTestId("tasks-column-active-list");
  await expect(card).toBeVisible({ timeout: 10_000 });

  await card.click();
  await expect(loggedInPage.getByText("Not scheduled")).toBeVisible();
  await loggedInPage.waitForTimeout(300);

  const cardBox = await card.boundingBox();
  const activeBox = await activeColumn.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(activeBox).not.toBeNull();

  await loggedInPage.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + cardBox!.height / 2);
  await loggedInPage.mouse.down();
  await loggedInPage.mouse.move(activeBox!.x + activeBox!.width / 2, activeBox!.y + 40, { steps: 12 });
  await loggedInPage.mouse.move(activeBox!.x + activeBox!.width / 2, activeBox!.y + activeBox!.height / 2, { steps: 12 });
  await loggedInPage.mouse.up();

  await expect
    .poll(async () => {
      const res = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { items: Array<{ id: string; state?: string }> };
      return body.items.find(m => m.id === task.id)?.state;
    }, { timeout: 10_000 })
    .toBe("running");
  await expect(activeColumn.getByTestId(`task-row-${task.id}`)).toBeVisible({ timeout: 10_000 });
  await cancelTaskAndRuns(serverUrl, token, chat.id, task.id);
});
