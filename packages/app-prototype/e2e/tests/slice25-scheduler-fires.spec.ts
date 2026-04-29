/**
 * Slice 25 — DB poll loop fires scheduled and recurring tasks end-to-end.
 *
 * Seeds tasks via the REST API with executeAt in the past and waits for
 * the server's poll tick (every 2 s in e2e) to fire them, asserting the
 * correct state transitions without any browser interaction.
 */
import { test, expect } from "../fixtures";

type MessageRecord = {
  id: string;
  state?: string;
  kind?: string;
  parentId?: string | null;
  executeAt?: string | null;
};

async function seedTask(
  serverUrl: string,
  token: string,
  opts: { title: string; executeAt?: string; cron?: string },
): Promise<{ chatId: string; taskId: string }> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const auth = { Authorization: `Bearer ${token}` };

  const wsList = (await (
    await fetch(`${serverUrl}/workspaces`, { headers: auth })
  ).json()) as Array<{ id: string }>;
  const agents = (await (
    await fetch(`${serverUrl}/agents`, { headers: auth })
  ).json()) as Array<{ id: string }>;

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: wsList[0].id, agentId: agents[0].id, title: opts.title }),
    })
  ).json()) as { id: string };

  const taskMsg = (await (
    await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: opts.title,
        kind: "task",
        title: opts.title,
        executeAt: opts.executeAt,
        cron: opts.cron,
      }),
    })
  ).json()) as { id: string };

  return { chatId: chat.id, taskId: taskMsg.id };
}

async function listMessages(
  serverUrl: string,
  token: string,
  chatId: string,
): Promise<MessageRecord[]> {
  const res = await fetch(`${serverUrl}/chats/${chatId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { items: MessageRecord[] };
  return body.items;
}

async function findMessage(
  serverUrl: string,
  token: string,
  chatId: string,
  messageId: string,
): Promise<MessageRecord | undefined> {
  const items = await listMessages(serverUrl, token, chatId);
  return items.find((m) => m.id === messageId);
}

test("one-shot task: poll loop fires it and transitions to succeeded", async ({
  serverUrl,
  token,
}) => {
  const pastIso = new Date(Date.now() - 1000).toISOString();
  const { chatId, taskId } = await seedTask(serverUrl, token, {
    title: "Slice25 one-shot",
    executeAt: pastIso,
  });

  // Wait for a task_run child to appear — proof the poll loop fired the task.
  await expect
    .poll(
      async () => {
        const items = await listMessages(serverUrl, token, chatId);
        return items.some((m) => m.kind === "task_run" && m.parentId === taskId);
      },
      { timeout: 12_000, intervals: [500, 500, 1000, 1000, 2000, 2000] },
    )
    .toBe(true);

  // One-shot task: definition must reach succeeded and clear executeAt.
  const task = await findMessage(serverUrl, token, chatId, taskId);
  expect(task?.state).toBe("succeeded");
  expect(task?.executeAt ?? null).toBeNull();
});

test("recurring task: poll loop fires it and keeps it pending with advanced executeAt", async ({
  serverUrl,
  token,
}) => {
  const pastIso = new Date(Date.now() - 1000).toISOString();
  const { chatId, taskId } = await seedTask(serverUrl, token, {
    title: "Slice25 recurring",
    executeAt: pastIso,
    cron: "*/1 * * * *",
  });

  // Wait for a task_run child — the cron task fired at least once.
  await expect
    .poll(
      async () => {
        const items = await listMessages(serverUrl, token, chatId);
        return items.some((m) => m.kind === "task_run" && m.parentId === taskId);
      },
      { timeout: 12_000, intervals: [500, 500, 1000, 1000, 2000, 2000] },
    )
    .toBe(true);

  // Recurring task: must stay pending with executeAt advanced to the future.
  const task = await findMessage(serverUrl, token, chatId, taskId);
  expect(task?.state).toBe("pending");
  expect(task?.executeAt).toBeDefined();
  expect(new Date(task!.executeAt!).getTime()).toBeGreaterThan(Date.now());
});
