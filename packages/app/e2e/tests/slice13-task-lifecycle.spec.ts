/**
 * Slice 13 — Task lifecycle (pause / resume / cancel) + chat deep-link.
 *
 * Seeds a `kind='task'` self-firing message scheduled 24h in the future
 * via the memory schedule adapter — the row stays pending forever and is
 * the stable scheduled task we drive the panel against. (The previous
 * summary_request fixture moved to `kind='summary'` and no longer
 * surfaces on the Tasks page; tasks must be `kind='task'`.)
 */
import { test, expect } from "../fixtures";

interface Seeded {
  chatId: string;
  messageId: string;
  workspaceId: string;
  chatTitle: string;
}

async function seedScheduledTask(
  serverUrl: string,
  token: string,
  chatTitle: string,
): Promise<Seeded> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const authHeaders = { Authorization: `Bearer ${token}` };
  const wsList = (await (
    await fetch(`${serverUrl}/workspaces`, { headers: authHeaders })
  ).json()) as Array<{ id: string }>;
  const agents = (await (
    await fetch(`${serverUrl}/agents`, { headers: authHeaders })
  ).json()) as Array<{ id: string }>;

  const chatRes = await fetch(`${serverUrl}/chats`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      workspaceId: wsList[0].id,
      agentId: agents[0].id,
      title: chatTitle,
    }),
  });
  expect(chatRes.status).toBe(201);
  const chat = (await chatRes.json()) as { id: string };

  const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const postRes = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: chatTitle,
      kind: "task",
      title: chatTitle,
      executeAt: futureIso,
    }),
  });
  expect(postRes.status).toBeGreaterThanOrEqual(200);
  expect(postRes.status).toBeLessThan(300);
  const taskMsg = (await postRes.json()) as { id: string };

  return {
    chatId: chat.id,
    messageId: taskMsg.id,
    workspaceId: wsList[0].id,
    chatTitle,
  };
}

async function getMyUserId(serverUrl: string, token: string): Promise<string> {
  const res = await fetch(`${serverUrl}/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function readMessageState(
  serverUrl: string,
  token: string,
  chatId: string,
  messageId: string,
): Promise<string | undefined> {
  const res = await fetch(`${serverUrl}/chats/${chatId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { items: Array<{ id: string; state?: string }> };
  return body.items.find((m) => m.id === messageId)?.state;
}

async function readMessageSnapshot(
  serverUrl: string,
  token: string,
  chatId: string,
  messageId: string,
): Promise<{ state?: string; executeAt?: string; taskRunStates: string[] }> {
  const res = await fetch(`${serverUrl}/chats/${chatId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as {
    items: Array<{ id: string; parentId?: string; kind?: string; state?: string; executeAt?: string }>;
  };
  const parent = body.items.find((m) => m.id === messageId);
  return {
    state: parent?.state,
    executeAt: parent?.executeAt,
    taskRunStates: body.items
      .filter((m) => m.parentId === messageId && m.kind === "task_run")
      .map((m) => m.state ?? ""),
  };
}

async function readMessageDetails(
  serverUrl: string,
  token: string,
  chatId: string,
  messageId: string,
): Promise<{ title?: string | null; content?: unknown } | undefined> {
  const res = await fetch(`${serverUrl}/chats/${chatId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as {
    items: Array<{ id: string; title?: string | null; content?: unknown }>;
  };
  return body.items.find((m) => m.id === messageId);
}

async function openTaskDetail(
  page: import("@playwright/test").Page,
  seeded: Seeded,
) {
  await page.reload();
  await page.getByRole("link", { name: /^Tasks$/ }).first().click();
  await page.getByTestId(`task-row-${seeded.messageId}`).click();
  await expect(page.getByTestId("task-status-trigger")).toBeVisible({ timeout: 5_000 });
}

test("task detail panel pauses, resumes, and cancels the server message", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const seeded = await seedScheduledTask(serverUrl, token, "Slice13 lifecycle");
  await openTaskDetail(loggedInPage, seeded);

  // Pause.
  await loggedInPage.getByTestId("task-pause").click();
  await expect
    .poll(() => readMessageState(serverUrl, token, seeded.chatId, seeded.messageId), {
      timeout: 5_000,
    })
    .toBe("paused");
  await expect(loggedInPage.getByTestId("task-resume")).toBeVisible();

  // Resume.
  await loggedInPage.getByTestId("task-resume").click();
  await expect
    .poll(() => readMessageState(serverUrl, token, seeded.chatId, seeded.messageId), {
      timeout: 5_000,
    })
    .toBe("pending");
  await expect(loggedInPage.getByTestId("task-pause")).toBeVisible();

  // Cancel.
  await loggedInPage.getByTestId("task-cancel").click();
  await expect
    .poll(() => readMessageState(serverUrl, token, seeded.chatId, seeded.messageId), {
      timeout: 5_000,
    })
    .toBe("cancelled");
});

// Removed: "task detail chat tab links to originating chat with message
// deep-link". The Chat tab is now an embedded ChatInPanel rendering the
// conversation in place, not a button that navigates to /w/.../desk with
// a chat=...&message=... query string. Re-add only if a deep-link
// affordance comes back.

test("scheduled-but-never-fired task hides the 'Last run' row", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const seeded = await seedScheduledTask(serverUrl, token, "Slice13 no last run");
  await openTaskDetail(loggedInPage, seeded);

  await expect(loggedInPage.getByText("Next run")).toBeVisible();
  await expect(loggedInPage.getByText(/^Last run$/)).toHaveCount(0);
  // History section is collapsed by default — expand it to surface the
  // empty-state placeholder.
  await loggedInPage.getByRole("button", { name: /^History$/ }).click();
  await expect(loggedInPage.getByTestId("task-history-empty")).toBeVisible();
});

test("task detail can run a scheduled task manually without consuming its schedule", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const seeded = await seedScheduledTask(serverUrl, token, "Slice13 manual scheduled run");
  const before = await readMessageSnapshot(serverUrl, token, seeded.chatId, seeded.messageId);
  const userId = await getMyUserId(serverUrl, token);

  await loggedInPage.evaluate(({ uid }: { uid: string }) => {
    localStorage.setItem(`desk.prefs.${uid}`, JSON.stringify({ developerMode: true }));
  }, { uid: userId });

  await openTaskDetail(loggedInPage, seeded);
  await loggedInPage.getByTestId("task-run-now").click();

  await expect
    .poll(() => readMessageSnapshot(serverUrl, token, seeded.chatId, seeded.messageId), {
      timeout: 10_000,
    })
    .toMatchObject({
      state: "pending",
      executeAt: before.executeAt,
      taskRunStates: ["succeeded"],
    });
  await expect(loggedInPage.getByText(/^task run:/)).toHaveCount(0);
});

test("task detail edits the backing task message title and description", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const seeded = await seedScheduledTask(serverUrl, token, "Slice13 edit original");
  await openTaskDetail(loggedInPage, seeded);

  await loggedInPage.getByTestId("task-title-input").fill("Slice13 edited title");
  await loggedInPage.getByTestId("task-description-input").fill("Edited task description");
  await expect(loggedInPage.getByTestId("task-details-save")).toBeVisible();
  await loggedInPage.getByTestId("task-details-save").click();

  await expect(loggedInPage.getByTestId("task-title-input")).toHaveValue("Slice13 edited title");
  await expect(loggedInPage.getByTestId("task-description-input")).toHaveValue("Edited task description");
  await expect(loggedInPage.getByTestId("task-details-save")).toHaveCount(0);

  await expect
    .poll(() => readMessageDetails(serverUrl, token, seeded.chatId, seeded.messageId), {
      timeout: 5_000,
    })
    .toMatchObject({
      title: "Slice13 edited title",
      content: { type: "text", text: "Slice13 edited title\n\nEdited task description" },
    });
});
