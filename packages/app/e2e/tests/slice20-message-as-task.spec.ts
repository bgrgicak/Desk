/**
 * Slice 20 — message-as-task wiring.
 *
 * Exercises the new `kind='task'` shape end-to-end:
 *   - POST /chats/:id/messages with `kind: 'task'`, `title`, `executeAt`
 *     creates a single self-firing row (no `agent_turn` trigger).
 *   - GET /messages?kind=task returns it.
 *   - GET /messages?kind=task&workspaceId=… is workspace-scoped.
 *   - The Tasks page (still on `?scheduled=true` until the client swap)
 *     surfaces the task via its execute_at — confirms the row carries
 *     scheduling metadata.
 *
 * The plan is at packages/server/docs/plans/message-as-task.md.
 */
import { test, expect } from "../fixtures";

test("POST /chats/:id/messages with kind=task creates a task and lists under ?kind=task", async ({
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
  const wsId = wsList[0].id;

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: wsId,
        agentId: agents[0].id,
        title: "Slice20 task container",
      }),
    })
  ).json()) as { id: string };

  const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const taskInstruction = "Audit the slice20 numbers";

  const postRes = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: taskInstruction,
      kind: "task",
      title: "Audit Q2",
      executeAt: futureIso,
    }),
  });
  expect(postRes.status).toBeGreaterThanOrEqual(200);
  expect(postRes.status).toBeLessThan(300);
  const created = (await postRes.json()) as {
    id: string;
    kind?: string;
    title?: string | null;
    executeAt?: string;
    chatId: string;
  };
  expect(created.kind).toBe("task");
  expect(created.title).toBe("Audit Q2");
  expect(created.executeAt).toBe(futureIso);

  // Listing by kind returns the row, scoped to its workspace.
  const kindRes = await fetch(
    `${serverUrl}/messages?kind=task&workspaceId=${wsId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(kindRes.status).toBe(200);
  const kindBody = (await kindRes.json()) as {
    items: Array<{ id: string; kind?: string; title?: string | null }>;
  };
  const found = kindBody.items.find((m) => m.id === created.id);
  expect(found).toBeDefined();
  expect(found!.kind).toBe("task");
  expect(found!.title).toBe("Audit Q2");

  // The same task is also a "scheduled" message — passes the legacy filter
  // the Tasks page still uses today.
  const schedRes = await fetch(
    `${serverUrl}/messages?scheduled=true&workspaceId=${wsId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const schedBody = (await schedRes.json()) as { items: Array<{ id: string }> };
  expect(schedBody.items.some((m) => m.id === created.id)).toBe(true);

  // UI sanity: open Tasks page. The card text is m.title ?? firstLine(content),
  // so a task with `title='Audit Q2'` renders the title rather than the content body.
  await loggedInPage.reload();
  await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();
  await expect(
    loggedInPage.getByText("Audit Q2").first(),
  ).toBeVisible({ timeout: 10_000 });
});

test("kind=task is workspace-scoped and a task in workspace A is invisible to workspace B's listing", async ({
  serverUrl,
  token,
}) => {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const wsList = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;
  test.skip(wsList.length < 2, "needs two workspaces; skipping in single-ws envs");
  const agents = (await (
    await fetch(`${serverUrl}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;
  const [wsA, wsB] = wsList;

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: wsA.id,
        agentId: agents[0].id,
        title: "Slice20 wsA task container",
      }),
    })
  ).json()) as { id: string };

  const created = (await (
    await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: "wsA-only task",
        kind: "task",
        title: "wsA task",
        executeAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    })
  ).json()) as { id: string };

  const wsBList = (await (
    await fetch(`${serverUrl}/messages?kind=task&workspaceId=${wsB.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as { items: Array<{ id: string }> };
  expect(wsBList.items.some((m) => m.id === created.id)).toBe(false);
});
