/**
 * Schedule editor — set cron and one-shot executeAt from the task detail
 * panel and verify the server message reflects the change.
 */
import { test, expect } from "../fixtures";

interface Seeded {
  chatId: string;
  messageId: string;
  workspaceId: string;
}

async function seedTask(serverUrl: string, token: string, title: string): Promise<Seeded> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const auth = { Authorization: `Bearer ${token}` };
  const wsList = (await (await fetch(`${serverUrl}/workspaces`, { headers: auth })).json()) as Array<{ id: string }>;
  const agents = (await (await fetch(`${serverUrl}/agents`, { headers: auth })).json()) as Array<{ id: string }>;
  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: wsList[0].id, agentId: agents[0].id, title }),
    })
  ).json()) as { id: string };
  const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const taskMsg = (await (
    await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: title, kind: "task", title, executeAt: futureIso }),
    })
  ).json()) as { id: string };
  return { chatId: chat.id, messageId: taskMsg.id, workspaceId: wsList[0].id };
}

async function readMessage(
  serverUrl: string,
  token: string,
  chatId: string,
  messageId: string,
): Promise<{ executeAt?: string | null; cron?: string | null; state?: string } | undefined> {
  const res = await fetch(`${serverUrl}/chats/${chatId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { items: Array<{ id: string; executeAt?: string | null; cron?: string | null; state?: string }> };
  return body.items.find((m) => m.id === messageId);
}

async function openTaskDetail(page: import("@playwright/test").Page, seeded: Seeded) {
  await page.reload();
  await page.getByRole("button", { name: /^Tasks$/ }).first().click();
  await page.getByTestId(`task-row-${seeded.messageId}`).click();
  await expect(page.getByTestId("task-status-trigger")).toBeVisible({ timeout: 5_000 });
}

test("schedule editor sets a daily cron", async ({ loggedInPage, serverUrl, token }) => {
  const seeded = await seedTask(serverUrl, token, "Schedule editor cron");
  await openTaskDetail(loggedInPage, seeded);

  await loggedInPage.getByTestId("task-schedule-trigger").click();
  await expect(loggedInPage.getByTestId("schedule-editor")).toBeVisible();

  await loggedInPage.getByTestId("schedule-mode-recurring").click();
  // Default cadence is `daily`; just set the time to 09:00 and save.
  await loggedInPage.getByTestId("schedule-recur-time").fill("09:00");
  await loggedInPage.getByTestId("schedule-save").click();

  await expect.poll(
    async () => (await readMessage(serverUrl, token, seeded.chatId, seeded.messageId))?.cron,
    { timeout: 5_000 },
  ).toBe("0 9 * * *");

  // The one-shot executeAt should be cleared when switching to cron.
  const msg = await readMessage(serverUrl, token, seeded.chatId, seeded.messageId);
  expect(msg?.executeAt ?? null).toBeNull();
});

test("schedule editor sets a one-shot executeAt", async ({ loggedInPage, serverUrl, token }) => {
  const seeded = await seedTask(serverUrl, token, "Schedule editor once");
  await openTaskDetail(loggedInPage, seeded);

  await loggedInPage.getByTestId("task-schedule-trigger").click();
  await expect(loggedInPage.getByTestId("schedule-editor")).toBeVisible();

  // Default mode is `once`; write a known date+time and save.
  await loggedInPage.getByTestId("schedule-once-date").fill("2099-12-31");
  await loggedInPage.getByTestId("schedule-once-time").fill("14:30");
  await loggedInPage.getByTestId("schedule-save").click();

  await expect.poll(
    async () => (await readMessage(serverUrl, token, seeded.chatId, seeded.messageId))?.executeAt,
    { timeout: 5_000 },
  ).toMatch(/^2099-12-31T/);
});

test("schedule editor clears the schedule", async ({ loggedInPage, serverUrl, token }) => {
  const seeded = await seedTask(serverUrl, token, "Schedule editor clear");
  await openTaskDetail(loggedInPage, seeded);

  await loggedInPage.getByTestId("task-schedule-trigger").click();
  await loggedInPage.getByTestId("schedule-clear").click();

  await expect.poll(
    async () => (await readMessage(serverUrl, token, seeded.chatId, seeded.messageId))?.executeAt ?? null,
    { timeout: 5_000 },
  ).toBeNull();

  const msg = await readMessage(serverUrl, token, seeded.chatId, seeded.messageId);
  expect(msg?.cron ?? null).toBeNull();
});
