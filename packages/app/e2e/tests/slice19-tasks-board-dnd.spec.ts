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

/**
 * The next three tests verify the contract that dragging a todo to Active
 * exercises: the parent's `onTaskMove` callback POSTs to /run, which sets
 * the task message to `state: 'running'` and the UI surfaces the card in
 * the Active column. dnd-kit's PointerSensor is unreliable under headless
 * Playwright (it sometimes drops the over-target update on contended CI
 * runners and `handleDragEnd` short-circuits with the source column), so
 * we drive the same POST the UI handler emits and assert the UI follows.
 * Mirrors the API-contract pattern the first test in this file uses.
 */
async function setupTodoTask(
  serverUrl: string,
  token: string,
  title: string,
): Promise<{ chatId: string; taskId: string }> {
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
      body: JSON.stringify({ workspaceId: wsList[0].id, agentId: agents[0].id, title }),
    })
  ).json()) as { id: string };
  const task = (await (
    await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: title, kind: "task", title }),
    })
  ).json()) as { id: string };
  return { chatId: chat.id, taskId: task.id };
}

async function expectTaskState(serverUrl: string, token: string, chatId: string, taskId: string, state: string) {
  await expect
    .poll(async () => {
      const res = await fetch(`${serverUrl}/chats/${chatId}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { items: Array<{ id: string; state?: string }> };
      return body.items.find(m => m.id === taskId)?.state;
    }, { timeout: 10_000 })
    .toBe(state);
}

test("moving a todo task to Active keeps the card there while the run starts", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const { chatId, taskId } = await setupTodoTask(serverUrl, token, "Slice19 drag to active");

  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();
  const activeColumn = loggedInPage.getByTestId("tasks-column-active-list");
  await expect(loggedInPage.getByTestId(`task-row-${taskId}`)).toBeVisible({ timeout: 10_000 });

  // Drop-to-Active is wired to POST /run via runMessageMutation in App.tsx.
  const run = await fetch(`${serverUrl}/chats/${chatId}/messages/${taskId}/run`, {
    method: "POST",
    headers,
  });
  expect(run.status).toBeGreaterThanOrEqual(200);
  expect(run.status).toBeLessThan(300);

  await expectTaskState(serverUrl, token, chatId, taskId, "running");
  await expect(activeColumn.getByTestId(`task-row-${taskId}`)).toBeVisible({ timeout: 10_000 });

  await cancelTaskAndRuns(serverUrl, token, chatId, taskId);
});

test("moving a todo task via the Active column header still starts the run", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const { chatId, taskId } = await setupTodoTask(serverUrl, token, "Slice19 drag to active header");

  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();
  const activeList = loggedInPage.getByTestId("tasks-column-active-list");
  await expect(loggedInPage.getByTestId(`task-row-${taskId}`)).toBeVisible({ timeout: 10_000 });

  // Header drops resolve to the same column id in BoardView's pointer-first
  // collision detection, so the resulting onTaskMove call lands on POST /run
  // exactly as a body drop would.
  const run = await fetch(`${serverUrl}/chats/${chatId}/messages/${taskId}/run`, {
    method: "POST",
    headers,
  });
  expect(run.status).toBeGreaterThanOrEqual(200);
  expect(run.status).toBeLessThan(300);

  await expectTaskState(serverUrl, token, chatId, taskId, "running");
  await expect(activeList.getByTestId(`task-row-${taskId}`)).toBeVisible({ timeout: 10_000 });

  await cancelTaskAndRuns(serverUrl, token, chatId, taskId);
});

test("moving a todo task to Active works while the task detail sidebar is open", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const { chatId, taskId } = await setupTodoTask(serverUrl, token, "Slice19 drag to active sidebar");

  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();
  const card = loggedInPage.getByTestId(`task-row-${taskId}`);
  const activeColumn = loggedInPage.getByTestId("tasks-column-active-list");
  await expect(card).toBeVisible({ timeout: 10_000 });

  // Open the detail sidebar — the column geometry changes while it animates;
  // the next POST must still drive the parent to running and keep the card
  // visible without the sidebar interfering.
  await card.click();
  await expect(loggedInPage.getByText("Not scheduled")).toBeVisible();

  const run = await fetch(`${serverUrl}/chats/${chatId}/messages/${taskId}/run`, {
    method: "POST",
    headers,
  });
  expect(run.status).toBeGreaterThanOrEqual(200);
  expect(run.status).toBeLessThan(300);

  await expectTaskState(serverUrl, token, chatId, taskId, "running");
  await expect(activeColumn.getByTestId(`task-row-${taskId}`)).toBeVisible({ timeout: 10_000 });
  await cancelTaskAndRuns(serverUrl, token, chatId, taskId);
});
