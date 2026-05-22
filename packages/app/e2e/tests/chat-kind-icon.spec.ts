/**
 * Chat-list `goal` + `kind` fields + sidebar icon.
 *
 * One goal source drives goal-aware UI:
 *   1. `goal` — the persisted picker-aligned chat goal
 *      (`app`/`document`/`image`/`data`/`site`/`run`/`task`/`scheduled`).
 *      Explicit picker selections and clear text inference both write here.
 *   2. `kind` — newest user-action message kind (`task`/`task_run`), with
 *      `chat` as fallback. Used only when `goal` is absent.
 *
 * `chat` and `summary` are NOT user actions; they fall back to the
 * default icon. The icons mirror the compose picker so the chat keeps the
 * type the user typed about.
 */
import { test, expect } from "../fixtures";
import type { MessageKind } from "@roomy-ai/shared";

interface Ctx {
  workspaceId: string;
  agentId: string;
  authHeaders: Record<string, string>;
  jsonHeaders: Record<string, string>;
}

async function bootstrap(serverUrl: string, token: string): Promise<Ctx> {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const jsonHeaders = { ...authHeaders, "Content-Type": "application/json" };
  const wsList = (await (
    await fetch(`${serverUrl}/workspaces`, { headers: authHeaders })
  ).json()) as Array<{ id: string }>;
  const agents = (await (
    await fetch(`${serverUrl}/agents`, { headers: authHeaders })
  ).json()) as Array<{ id: string }>;
  return {
    workspaceId: wsList[0].id,
    agentId: agents[0].id,
    authHeaders,
    jsonHeaders,
  };
}

async function createChat(serverUrl: string, ctx: Ctx, title: string): Promise<string> {
  const res = await fetch(`${serverUrl}/chats`, {
    method: "POST",
    headers: ctx.jsonHeaders,
    body: JSON.stringify({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      title,
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function postMessage(
  serverUrl: string,
  ctx: Ctx,
  chatId: string,
  kind: MessageKind,
  content: string,
  opts: { goal?: string | null } = {},
): Promise<void> {
  const body: Record<string, unknown> = { content, kind, ...opts };
  // Self-firing kinds need either an executeAt or cron, otherwise the
  // scheduler treats them as fire-immediately. Pin a far-future timestamp
  // so they sit pending and the icon assertion is stable.
  if (kind === "task" || kind === "summary") {
    body.executeAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }
  const res = await fetch(`${serverUrl}/chats/${chatId}/messages`, {
    method: "POST",
    headers: ctx.jsonHeaders,
    body: JSON.stringify(body),
  });
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
}

async function fetchListedKind(
  serverUrl: string,
  ctx: Ctx,
  chatId: string,
): Promise<string | undefined> {
  const res = await fetch(`${serverUrl}/chats?workspaceId=${ctx.workspaceId}`, {
    headers: ctx.authHeaders,
  });
  expect(res.status).toBe(200);
  const list = (await res.json()) as Array<{ id: string; kind?: string }>;
  return list.find((c) => c.id === chatId)?.kind;
}

async function fetchListedGoal(
  serverUrl: string,
  ctx: Ctx,
  chatId: string,
): Promise<string | undefined> {
  const res = await fetch(`${serverUrl}/chats?workspaceId=${ctx.workspaceId}`, {
    headers: ctx.authHeaders,
  });
  expect(res.status).toBe(200);
  const list = (await res.json()) as Array<{ id: string; goal?: string }>;
  return list.find((c) => c.id === chatId)?.goal;
}

test("composer goal picker restores the chat's persisted goal", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ctx = await bootstrap(serverUrl, token);
  const chatId = await createChat(serverUrl, ctx, "composer-goal-doc");
  await postMessage(serverUrl, ctx, chatId, "chat", "write the launch brief", {
    goal: "document",
  });
  expect(await fetchListedGoal(serverUrl, ctx, chatId)).toBe("document");

  await loggedInPage.reload();
  const row = loggedInPage
    .getByRole("link", { name: /composer-goal-doc/ })
    .first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();

  await expect(
    loggedInPage.getByRole("button", { name: /Document/ }).first(),
  ).toBeVisible();

  await loggedInPage.getByRole("button", { name: /Document/ }).first().click();
  await loggedInPage.getByRole("button", { name: /^Clear selection$/ }).click();
  // After clearing the goal the picker label flips back to the default
  // "Tools" trigger; the dropdown "Clear selection" entry is hidden again
  // (only rendered when a goal is active).
  await expect(
    loggedInPage.getByRole("button", { name: /^Tools$/ }).first(),
  ).toBeVisible();

  await loggedInPage.locator("textarea").fill("hello");
  await loggedInPage.keyboard.press("Enter");
  await expect.poll(() => fetchListedGoal(serverUrl, ctx, chatId)).toBeUndefined();
});

// UI test runs first so the browser context is launched before the
// API-only tests pile up server-side load (chromium spawn under load
// has flaked with newPage timeouts on this lane).
test("sidebar icon uses persisted goal, falls back to kind", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const ctx = await bootstrap(serverUrl, token);

  // No goal, no task — fallback MessageSquare.
  const plainId = await createChat(serverUrl, ctx, "icon-plain");
  await postMessage(serverUrl, ctx, plainId, "chat", "hi");

  // No goal, task kind — fallback ListTodo (matches picker).
  const taskOnlyId = await createChat(serverUrl, ctx, "icon-task-only");
  await postMessage(serverUrl, ctx, taskOnlyId, "task", "do the thing");

  // Task chat plus a system summary — the auto summary must not bump the
  // icon. This is the exact regression the bug report described.
  const taskWithSummaryId = await createChat(serverUrl, ctx, "icon-task-summary");
  await postMessage(serverUrl, ctx, taskWithSummaryId, "task", "do the thing");
  await postMessage(serverUrl, ctx, taskWithSummaryId, "summary", "scheduled summary");

  // Goal-driven: explicit data goal → Table icon.
  const dataId = await createChat(serverUrl, ctx, "icon-data");
  await postMessage(serverUrl, ctx, dataId, "chat", "craete a randon data table", { goal: "data" });

  // Goal-driven: explicit site goal → Globe icon.
  const siteId = await createChat(serverUrl, ctx, "icon-site");
  await postMessage(serverUrl, ctx, siteId, "chat", "show me a portfolio", { goal: "site" });

  await loggedInPage.reload();

  for (const title of [
    "icon-plain",
    "icon-task-only",
    "icon-task-summary",
    "icon-data",
    "icon-site",
  ]) {
    await expect(
      loggedInPage.getByRole("link", { name: new RegExp(title) }).first(),
    ).toBeVisible({ timeout: 10_000 });
  }

  // The full lucide-icon vocabulary the sidebar may render — every case
  // asserts its expected class is the ONLY one of these on the row.
  const ALL_ICONS = [
    "lucide-message-square",
    "lucide-list-todo",
    "lucide-zap",
    "lucide-file-text",
    "lucide-image",
    "lucide-table",
    "lucide-globe",
    "lucide-play",
    "lucide-calendar-clock",
  ];

  const cases: Array<{ title: string; expected: string }> = [
    { title: "icon-plain",         expected: "lucide-message-square" },
    { title: "icon-task-only",     expected: "lucide-list-todo" },
    { title: "icon-task-summary",  expected: "lucide-list-todo" },
    { title: "icon-data",          expected: "lucide-table" },
    { title: "icon-site",          expected: "lucide-globe" },
  ];

  for (const { title, expected } of cases) {
    const row = loggedInPage
      .getByRole("link", { name: new RegExp(title) })
      .first();
    await expect(
      row.locator(`svg.${expected}`),
      `chat "${title}" should render ${expected}`,
    ).toBeVisible();
    for (const cls of ALL_ICONS) {
      if (cls === expected) continue;
      await expect(
        row.locator(`svg.${cls}`),
        `chat "${title}" should NOT render ${cls}`,
      ).toHaveCount(0);
    }
  }
});

test("/chats `kind` reflects the newest user-action kind, with chat/summary as fallback", async ({
  serverUrl,
  token,
}) => {
  const ctx = await bootstrap(serverUrl, token);

  // Empty chat → fallback 'chat'.
  const emptyId = await createChat(serverUrl, ctx, "kind-empty");
  expect(await fetchListedKind(serverUrl, ctx, emptyId)).toBe("chat");

  // chat → task: kind flips to task.
  const chatThenTaskId = await createChat(serverUrl, ctx, "kind-chat-then-task");
  await postMessage(serverUrl, ctx, chatThenTaskId, "chat", "hi");
  await postMessage(serverUrl, ctx, chatThenTaskId, "task", "do the thing");
  expect(await fetchListedKind(serverUrl, ctx, chatThenTaskId)).toBe("task");

  // task → chat reply: task icon sticks (chat is a fallback).
  const taskThenChatId = await createChat(serverUrl, ctx, "kind-task-then-chat");
  await postMessage(serverUrl, ctx, taskThenChatId, "task", "do the thing");
  await postMessage(serverUrl, ctx, taskThenChatId, "chat", "follow-up");
  expect(await fetchListedKind(serverUrl, ctx, taskThenChatId)).toBe("task");

  // task → summary (the system-scheduled summary refresh that lands on every
  // chat turn) — must NOT hijack the icon. kind stays 'task'. This is the
  // exact regression the bug report uncovered.
  const taskThenSummaryId = await createChat(serverUrl, ctx, "kind-task-then-summary");
  await postMessage(serverUrl, ctx, taskThenSummaryId, "task", "do the thing");
  await postMessage(serverUrl, ctx, taskThenSummaryId, "summary", "scheduled summary");
  expect(await fetchListedKind(serverUrl, ctx, taskThenSummaryId)).toBe("task");

  // chat + summary alone (no user actions) → fallback 'chat'.
  const summaryOnlyId = await createChat(serverUrl, ctx, "kind-chat-and-summary");
  await postMessage(serverUrl, ctx, summaryOnlyId, "chat", "hi");
  await postMessage(serverUrl, ctx, summaryOnlyId, "summary", "scheduled summary");
  expect(await fetchListedKind(serverUrl, ctx, summaryOnlyId)).toBe("chat");
});

test("/chats `goal` is persisted from explicit message goal field", async ({
  serverUrl,
  token,
}) => {
  const ctx = await bootstrap(serverUrl, token);

  // Explicit goal field on the message is persisted on the chat.
  const dataId = await createChat(serverUrl, ctx, "goal-data");
  await postMessage(serverUrl, ctx, dataId, "chat", "craete a randon data table", { goal: "data" });
  expect(await fetchListedGoal(serverUrl, ctx, dataId)).toBe("data");

  // Explicit site goal.
  const siteId = await createChat(serverUrl, ctx, "goal-site");
  await postMessage(serverUrl, ctx, siteId, "chat", "show me a portfolio", { goal: "site" });
  expect(await fetchListedGoal(serverUrl, ctx, siteId)).toBe("site");

  // No explicit goal — stays unset.
  const plainId = await createChat(serverUrl, ctx, "goal-plain");
  await postMessage(serverUrl, ctx, plainId, "chat", "hi");
  expect(await fetchListedGoal(serverUrl, ctx, plainId)).toBeUndefined();
});
