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

async function openScheduleEditor(page: import("@playwright/test").Page, seeded: Seeded) {
  await page.reload();
  await page.getByRole("button", { name: /^Tasks$/ }).first().click();
  await page.getByTestId(`task-row-${seeded.messageId}`).click();
  await expect(page.getByTestId("task-status-trigger")).toBeVisible({ timeout: 5_000 });
  await page.getByTestId("task-schedule-trigger").click();
  await expect(page.getByTestId("schedule-editor")).toBeVisible();
  await page.getByTestId("schedule-mode-recurring").click();
}

test("schedule editor sets a daily cron", async ({ loggedInPage, serverUrl, token }) => {
  const seeded = await seedTask(serverUrl, token, "Schedule editor cron");
  await openScheduleEditor(loggedInPage, seeded);

  // Default unit is 'days'; set the time to 09:00 and save.
  await loggedInPage.getByTestId("schedule-recur-time").fill("09:00");
  await loggedInPage.getByTestId("schedule-save").click();

  await expect.poll(
    async () => (await readMessage(serverUrl, token, seeded.chatId, seeded.messageId))?.cron,
    { timeout: 5_000 },
  ).toBe("0 9 * * *");

  // With DB-poll scheduling, setting a cron expression also advances executeAt
  // to the next occurrence so the poll loop knows when to fire.
  const msg = await readMessage(serverUrl, token, seeded.chatId, seeded.messageId);
  expect(msg?.executeAt).toBeDefined();
});

test("schedule editor sets a weekly cron on Wednesday", async ({ loggedInPage, serverUrl, token }) => {
  const seeded = await seedTask(serverUrl, token, "Schedule editor weekly");
  await openScheduleEditor(loggedInPage, seeded);

  await loggedInPage.getByTestId("schedule-unit").selectOption("weeks");
  // Add Wednesday first, then deselect Monday — the guard prevents removing
  // the last selected weekday, so Wednesday must be selected before Monday is removed.
  await loggedInPage.getByTestId("schedule-weekday-3").click();
  await loggedInPage.getByTestId("schedule-weekday-1").click();
  await loggedInPage.getByTestId("schedule-recur-time").fill("10:00");
  await loggedInPage.getByTestId("schedule-save").click();

  await expect.poll(
    async () => (await readMessage(serverUrl, token, seeded.chatId, seeded.messageId))?.cron,
    { timeout: 5_000 },
  ).toBe("0 10 * * 3");
});

test("schedule editor sets a monthly cron on the 15th", async ({ loggedInPage, serverUrl, token }) => {
  const seeded = await seedTask(serverUrl, token, "Schedule editor monthly");
  await openScheduleEditor(loggedInPage, seeded);

  await loggedInPage.getByTestId("schedule-unit").selectOption("months");
  await loggedInPage.getByTestId("schedule-month-day").fill("15");
  await loggedInPage.getByTestId("schedule-recur-time").fill("08:00");
  await loggedInPage.getByTestId("schedule-save").click();

  await expect.poll(
    async () => (await readMessage(serverUrl, token, seeded.chatId, seeded.messageId))?.cron,
    { timeout: 5_000 },
  ).toBe("0 8 15 * *");
});

test("schedule editor sets an every-N-hours cron", async ({ loggedInPage, serverUrl, token }) => {
  const seeded = await seedTask(serverUrl, token, "Schedule editor hours");
  await openScheduleEditor(loggedInPage, seeded);

  await loggedInPage.getByTestId("schedule-unit").selectOption("hours");
  await loggedInPage.getByTestId("schedule-n").fill("6");
  await loggedInPage.getByTestId("schedule-save").click();

  await expect.poll(
    async () => (await readMessage(serverUrl, token, seeded.chatId, seeded.messageId))?.cron,
    { timeout: 5_000 },
  ).toBe("0 */6 * * *");
});

test("schedule editor sets an every-N-minutes cron", async ({ loggedInPage, serverUrl, token }) => {
  const seeded = await seedTask(serverUrl, token, "Schedule editor minutes");
  await openScheduleEditor(loggedInPage, seeded);

  await loggedInPage.getByTestId("schedule-unit").selectOption("minutes");
  await loggedInPage.getByTestId("schedule-n").fill("15");
  await loggedInPage.getByTestId("schedule-save").click();

  await expect.poll(
    async () => (await readMessage(serverUrl, token, seeded.chatId, seeded.messageId))?.cron,
    { timeout: 5_000 },
  ).toBe("*/15 * * * *");
});

test("schedule editor sets a one-shot executeAt", async ({ loggedInPage, serverUrl, token }) => {
  const seeded = await seedTask(serverUrl, token, "Schedule editor once");
  await openScheduleEditor(loggedInPage, seeded);

  await loggedInPage.getByTestId("schedule-mode-once").click();
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
  await openScheduleEditor(loggedInPage, seeded);
  await loggedInPage.getByTestId("schedule-clear").click();

  await expect.poll(
    async () => (await readMessage(serverUrl, token, seeded.chatId, seeded.messageId))?.executeAt ?? null,
    { timeout: 5_000 },
  ).toBeNull();

  const msg = await readMessage(serverUrl, token, seeded.chatId, seeded.messageId);
  expect(msg?.cron ?? null).toBeNull();
});

test("schedule label shows human-readable text", async ({ loggedInPage, serverUrl, token }) => {
  const seeded = await seedTask(serverUrl, token, "Schedule label readable");
  await openScheduleEditor(loggedInPage, seeded);

  // Set to every Monday at 9am
  await loggedInPage.getByTestId("schedule-unit").selectOption("weeks");
  await loggedInPage.getByTestId("schedule-recur-time").fill("09:00");
  await loggedInPage.getByTestId("schedule-save").click();

  // The schedule trigger label should show readable text, not a cron string
  await expect(loggedInPage.getByTestId("task-schedule-trigger")).not.toContainText("* * *");
  await expect(loggedInPage.getByTestId("task-schedule-trigger")).toContainText("Mo");
});
