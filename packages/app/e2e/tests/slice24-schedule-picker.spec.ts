/**
 * Slice 24 — schedule picker on existing tasks.
 *
 * Regression suite for the "Edit schedule" affordance that was added to
 * each TaskCard's ... menu. Earlier iterations rendered the picker in a
 * Radix Popover triggered from a dropdown-menu item; the menu's
 * focus-return on close dismissed the popover before the user could
 * interact with it. The picker now lives in a Dialog (its own focus
 * trap), and these tests pin that behaviour.
 *
 * Coverage:
 *   1. The dialog opens AND stays mounted after the menu closes.
 *   2. Editing a one-shot schedule's date+time then Save updates the
 *      backing message (`executeAt`) — verified via the REST API.
 *   3. Switching to Recurring and saving sends a cron expression and
 *      the schedule re-renders the next time the dialog opens.
 *   4. Clear removes both `executeAt` and `cron` on the server.
 */
import { test, expect } from "../fixtures";

interface ServerMessage {
  id: string;
  chatId: string;
  executeAt?: string | null;
  cron?: string | null;
  state?: string;
}

async function fetchTask(
  serverUrl: string,
  token: string,
  chatId: string,
  messageId: string,
): Promise<ServerMessage> {
  // There's no public GET /chats/:id/messages/:msgId — list and filter.
  // `view=full` keeps every message id even after the server's default
  // compaction.
  const res = await fetch(
    `${serverUrl}/chats/${chatId}/messages?view=full&limit=200`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: ServerMessage[] };
  const found = body.items.find((m) => m.id === messageId);
  if (!found) throw new Error(`Message ${messageId} not found in chat ${chatId}`);
  return found;
}

async function createScheduledTask(
  serverUrl: string,
  token: string,
  wsId: string,
  agentId: string,
  title: string,
): Promise<ServerMessage> {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: wsId, agentId, title: `${title} container` }),
    })
  ).json()) as { id: string };

  const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const created = (await (
    await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: title,
        kind: "task",
        title,
        executeAt: futureIso,
      }),
    })
  ).json()) as ServerMessage;
  expect(created.id).toBeTruthy();
  return created;
}

test.describe("schedule picker — existing task", () => {
  test("Once / Recurring tabs toggle the form in both directions", async ({
    loggedInPage,
    serverUrl,
    token,
  }) => {
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

    const task = await createScheduledTask(
      serverUrl,
      token,
      wsList[0].id,
      agents[0].id,
      "Slice24 tab toggle",
    );

    await loggedInPage.reload();
    await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();

    const card = loggedInPage.getByTestId(`task-card-${task.id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.getByTestId(`task-menu-${task.id}`).click();
    await loggedInPage.getByTestId(`task-schedule-${task.id}`).click();

    const dialog = loggedInPage.getByTestId(`task-schedule-dialog-${task.id}`);
    await expect(dialog).toBeVisible();

    // Default: a task seeded with `executeAt` (one-shot) opens in Once.
    await expect(dialog.getByTestId("schedule-once-date")).toBeVisible();
    await expect(dialog.getByTestId("schedule-recurring-time")).toBeHidden();

    // Recurring → recurring-only fields render and once-only fields don't.
    await dialog.getByTestId("schedule-tab-recurring").click();
    await expect(dialog.getByTestId("schedule-recurring-time")).toBeVisible();
    await expect(dialog.getByTestId("schedule-recurring-begin")).toBeVisible();
    await expect(dialog.getByTestId("schedule-recurring-end")).toBeVisible();
    await expect(dialog.getByTestId("schedule-once-date")).toBeHidden();

    // Back to Once → once fields again, recurring fields gone.
    await dialog.getByTestId("schedule-tab-once").click();
    await expect(dialog.getByTestId("schedule-once-date")).toBeVisible();
    await expect(dialog.getByTestId("schedule-once-time")).toBeVisible();
    await expect(dialog.getByTestId("schedule-recurring-time")).toBeHidden();

    // And once more to Recurring to prove the toggle is stable across
    // multiple round-trips — earlier the form occasionally got stuck
    // on the first selection when the popover stole focus mid-click.
    await dialog.getByTestId("schedule-tab-recurring").click();
    await expect(dialog.getByTestId("schedule-recurring-time")).toBeVisible();

    await dialog.getByTestId("schedule-cancel").click();
    await expect(dialog).toBeHidden();
  });


  test("dialog opens, stays visible, and is interactive", async ({
    loggedInPage,
    serverUrl,
    token,
  }) => {
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

    const task = await createScheduledTask(
      serverUrl,
      token,
      wsList[0].id,
      agents[0].id,
      "Slice24 click-through task",
    );

    await loggedInPage.reload();
    await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();

    const card = loggedInPage.getByTestId(`task-card-${task.id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // 1. Open the overflow menu.
    await card.getByTestId(`task-menu-${task.id}`).click();
    const scheduleItem = loggedInPage.getByTestId(`task-schedule-${task.id}`);
    await expect(scheduleItem).toBeVisible();

    // 2. Click "Edit schedule" → the dialog must open and STAY open.
    await scheduleItem.click();
    const dialog = loggedInPage.getByTestId(`task-schedule-dialog-${task.id}`);
    await expect(dialog).toBeVisible();
    // Give the menu's focus-return cycle a beat to fire — earlier the
    // dialog vanished here. Re-assert visibility to prove it sticks.
    await loggedInPage.waitForTimeout(250);
    await expect(dialog).toBeVisible();

    // 3. The picker form is interactive — the date/time inputs accept input.
    const dateInput = dialog.getByTestId("schedule-once-date");
    const timeInput = dialog.getByTestId("schedule-once-time");
    await expect(dateInput).toBeVisible();
    await expect(timeInput).toBeVisible();
    await expect(dialog.getByTestId("schedule-save")).toBeVisible();
    await expect(dialog.getByTestId("schedule-cancel")).toBeVisible();
    await expect(dialog.getByTestId("schedule-clear")).toBeVisible();

    // Cancel closes cleanly without persisting anything.
    await dialog.getByTestId("schedule-cancel").click();
    await expect(dialog).toBeHidden();

    const after = await fetchTask(serverUrl, token, task.chatId, task.id);
    expect(after.executeAt).toBe(task.executeAt);
    expect(after.cron ?? null).toBeNull();
  });

  test("editing the date+time persists via PATCH and re-opens with the new value", async ({
    loggedInPage,
    serverUrl,
    token,
  }) => {
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

    const task = await createScheduledTask(
      serverUrl,
      token,
      wsList[0].id,
      agents[0].id,
      "Slice24 one-shot edit",
    );

    await loggedInPage.reload();
    await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();

    const card = loggedInPage.getByTestId(`task-card-${task.id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.getByTestId(`task-menu-${task.id}`).click();
    await loggedInPage.getByTestId(`task-schedule-${task.id}`).click();

    const dialog = loggedInPage.getByTestId(`task-schedule-dialog-${task.id}`);
    await expect(dialog).toBeVisible();

    // Push the schedule out two more days, at 11:30 local. Use a date
    // we can predict and assert later: today + 3 days.
    const target = new Date();
    target.setDate(target.getDate() + 3);
    target.setHours(11, 30, 0, 0);
    const pad = (n: number) => n.toString().padStart(2, "0");
    const ymd = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
    const hm  = `${pad(target.getHours())}:${pad(target.getMinutes())}`;

    await dialog.getByTestId("schedule-once-date").fill(ymd);
    await dialog.getByTestId("schedule-once-time").fill(hm);
    await dialog.getByTestId("schedule-save").click();
    await expect(dialog).toBeHidden();

    // Server persistence: the new executeAt should be the local
    // timestamp the picker emitted (within a minute of `target`).
    await expect
      .poll(async () => {
        const m = await fetchTask(serverUrl, token, task.chatId, task.id);
        return m.executeAt;
      }, { timeout: 5_000 })
      .not.toBe(task.executeAt);

    const updated = await fetchTask(serverUrl, token, task.chatId, task.id);
    expect(updated.executeAt).toBeTruthy();
    const updatedMs = new Date(updated.executeAt!).getTime();
    expect(Math.abs(updatedMs - target.getTime())).toBeLessThan(60_000);
    expect(updated.cron ?? null).toBeNull();

    // Re-open the dialog: it should now seed from the saved value, not
    // the original 24-hour-out value.
    await card.getByTestId(`task-menu-${task.id}`).click();
    await loggedInPage.getByTestId(`task-schedule-${task.id}`).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("schedule-once-date")).toHaveValue(ymd);
    await expect(dialog.getByTestId("schedule-once-time")).toHaveValue(hm);
    await dialog.getByTestId("schedule-cancel").click();
  });

  test("switching to Recurring saves a cron expression", async ({
    loggedInPage,
    serverUrl,
    token,
  }) => {
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

    const task = await createScheduledTask(
      serverUrl,
      token,
      wsList[0].id,
      agents[0].id,
      "Slice24 recurring switch",
    );

    await loggedInPage.reload();
    await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();

    const card = loggedInPage.getByTestId(`task-card-${task.id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.getByTestId(`task-menu-${task.id}`).click();
    await loggedInPage.getByTestId(`task-schedule-${task.id}`).click();

    const dialog = loggedInPage.getByTestId(`task-schedule-dialog-${task.id}`);
    await expect(dialog).toBeVisible();

    await dialog.getByTestId("schedule-tab-recurring").click();
    // Default recurring schedule = every 1 day at 09:00 → cron "0 9 * * *".
    // Set the recurring time to 09:00 explicitly so the assertion isn't
    // sensitive to "next hour" defaults if the form ever changes seed.
    await dialog.getByTestId("schedule-recurring-time").fill("09:00");
    await dialog.getByTestId("schedule-save").click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(async () => {
        const m = await fetchTask(serverUrl, token, task.chatId, task.id);
        return m.cron;
      }, { timeout: 5_000 })
      .toBe("0 9 * * *");

    // The card meta also picks up the human-readable form once the WS
    // patch reaches the client cache.
    await expect(card).toContainText(/Every day at 9 AM/i, { timeout: 10_000 });
  });

  test("Clear removes both executeAt and cron from the message", async ({
    loggedInPage,
    serverUrl,
    token,
  }) => {
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

    const task = await createScheduledTask(
      serverUrl,
      token,
      wsList[0].id,
      agents[0].id,
      "Slice24 clear",
    );

    await loggedInPage.reload();
    await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();

    const card = loggedInPage.getByTestId(`task-card-${task.id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.getByTestId(`task-menu-${task.id}`).click();
    await loggedInPage.getByTestId(`task-schedule-${task.id}`).click();

    const dialog = loggedInPage.getByTestId(`task-schedule-dialog-${task.id}`);
    await expect(dialog).toBeVisible();

    await dialog.getByTestId("schedule-clear").click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(async () => {
        const m = await fetchTask(serverUrl, token, task.chatId, task.id);
        return m.executeAt ?? null;
      }, { timeout: 5_000 })
      .toBeNull();

    const final = await fetchTask(serverUrl, token, task.chatId, task.id);
    expect(final.executeAt ?? null).toBeNull();
    expect(final.cron ?? null).toBeNull();
  });
});

test.describe("schedule picker — state preservation across parent re-renders", () => {
  test("user edits survive a WS-driven parent re-render (regression: initial-reseed effect)", async ({
    loggedInPage,
    serverUrl,
    token,
  }) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
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

    const task = await createScheduledTask(
      serverUrl,
      token,
      wsList[0].id,
      agents[0].id,
      "Slice24 reseed-regression target",
    );

    await loggedInPage.reload();
    await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();

    const card = loggedInPage.getByTestId(`task-card-${task.id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByTestId(`task-menu-${task.id}`).click();
    await loggedInPage.getByTestId(`task-schedule-${task.id}`).click();

    const dialog = loggedInPage.getByTestId(`task-schedule-dialog-${task.id}`);
    await expect(dialog).toBeVisible();

    // Switch to Recurring and pick a non-default time so we can later
    // assert the user-entered value is still present.
    await dialog.getByTestId("schedule-tab-recurring").click();
    await dialog.getByTestId("schedule-recurring-time").fill("07:42");
    await expect(dialog.getByTestId("schedule-recurring-time")).toHaveValue("07:42");

    // Force the Tasks page to re-render by appending a new task in the
    // same workspace via the API. The WS `message.appended` event
    // refreshes the Tasks query, every TaskCard re-renders, and the
    // schedule editor's parent rebuilds its `initial` prop. Before the
    // fix, this fired the picker's reset effect and the user's edits
    // (tab choice + time) vanished. After: the form must stay put.
    const chat = (await (
      await fetch(`${serverUrl}/chats`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          workspaceId: wsList[0].id,
          agentId: agents[0].id,
          title: "Slice24 reseed-regression noise",
        }),
      })
    ).json()) as { id: string };
    await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: "Slice24 reseed-regression noise task",
        kind: "task",
        title: "Reseed regression noise",
        executeAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    });

    // Wait long enough for the WS round-trip + RTK Query
    // refresh to propagate. 1s is generous; the bug surfaced
    // immediately on the next render.
    await loggedInPage.waitForTimeout(1_000);

    // Tab choice survived.
    await expect(dialog.getByTestId("schedule-recurring-time")).toBeVisible();
    await expect(dialog.getByTestId("schedule-once-date")).toBeHidden();
    // Time field still holds the user's input.
    await expect(dialog.getByTestId("schedule-recurring-time")).toHaveValue("07:42");

    // Saving still emits the user's chosen cron, not the original seed.
    await dialog.getByTestId("schedule-save").click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(async () => {
        const m = await fetchTask(serverUrl, token, task.chatId, task.id);
        return m.cron;
      }, { timeout: 5_000 })
      .toBe("42 7 * * *");
  });

  test("composer edits survive a WS-driven re-render too", async ({
    loggedInPage,
    serverUrl,
    token,
  }) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
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

    await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();
    const trigger = loggedInPage.getByTestId("composer-schedule-trigger");
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();

    const dialog = loggedInPage.getByTestId("composer-schedule-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("schedule-tab-recurring").click();
    await dialog.getByTestId("schedule-recurring-time").fill("18:15");

    // Inject an external WS event mid-edit (same mechanism as above).
    const chat = (await (
      await fetch(`${serverUrl}/chats`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          workspaceId: wsList[0].id,
          agentId: agents[0].id,
          title: "Slice24 composer reseed noise",
        }),
      })
    ).json()) as { id: string };
    await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: "Slice24 composer reseed noise task",
        kind: "task",
        title: "Composer reseed noise",
        executeAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    });

    await loggedInPage.waitForTimeout(1_000);

    await expect(dialog.getByTestId("schedule-recurring-time")).toBeVisible();
    await expect(dialog.getByTestId("schedule-recurring-time")).toHaveValue("18:15");
    await dialog.getByTestId("schedule-cancel").click();
  });
});

test.describe("schedule picker — Tasks composer", () => {
  test("Once / Recurring tabs toggle freely inside the composer dialog", async ({
    loggedInPage,
  }) => {
    await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();

    // The Schedule trigger lives in the bottom composer toolbar. Always
    // visible because the Tasks-page composer is hard-wired to the
    // `task` goal.
    const trigger = loggedInPage.getByTestId("composer-schedule-trigger");
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();

    const dialog = loggedInPage.getByTestId("composer-schedule-dialog");
    await expect(dialog).toBeVisible();

    // Sanity: dialog survives a brief idle (would catch a popover
    // close-on-mount regression here too).
    await loggedInPage.waitForTimeout(250);
    await expect(dialog).toBeVisible();

    // Toggle back-and-forth a few times.
    await dialog.getByTestId("schedule-tab-recurring").click();
    await expect(dialog.getByTestId("schedule-recurring-time")).toBeVisible();

    await dialog.getByTestId("schedule-tab-once").click();
    await expect(dialog.getByTestId("schedule-once-date")).toBeVisible();
    await expect(dialog.getByTestId("schedule-recurring-time")).toBeHidden();

    await dialog.getByTestId("schedule-tab-recurring").click();
    await expect(dialog.getByTestId("schedule-recurring-time")).toBeVisible();
    await expect(dialog.getByTestId("schedule-once-date")).toBeHidden();

    await dialog.getByTestId("schedule-cancel").click();
    await expect(dialog).toBeHidden();
  });

  test("composer saves a recurring schedule and the new task lands with a cron", async ({
    loggedInPage,
    serverUrl,
    token,
  }) => {
    await loggedInPage.getByRole("link", { name: /^Tasks$/ }).first().click();

    const trigger = loggedInPage.getByTestId("composer-schedule-trigger");
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();

    const dialog = loggedInPage.getByTestId("composer-schedule-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("schedule-tab-recurring").click();
    await dialog.getByTestId("schedule-recurring-time").fill("09:00");
    await dialog.getByTestId("schedule-save").click();
    await expect(dialog).toBeHidden();

    // Trigger label should now describe the cron.
    await expect(trigger).toContainText(/Every day at 9 AM/i);

    // Type a task and send via Enter (the composer's default submit).
    const taskBody = `Slice24 composer cron ${Date.now()}`;
    const textarea = loggedInPage.locator(
      'textarea[placeholder="What do you want to achieve?"]',
    );
    await textarea.fill(taskBody);
    await textarea.press("Enter");

    // Verify server-side: the new task lands with the chosen cron.
    const wsList = (await (
      await fetch(`${serverUrl}/workspaces`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as Array<{ id: string }>;
    await expect
      .poll(async () => {
        const res = await fetch(
          `${serverUrl}/messages?kind=task&workspaceId=${wsList[0].id}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const body = (await res.json()) as {
          items: Array<{ title?: string | null; cron?: string | null }>;
        };
        const found = body.items.find((m) => m.title === taskBody);
        return found?.cron ?? null;
      }, { timeout: 10_000 })
      .toBe("0 9 * * *");
  });
});
