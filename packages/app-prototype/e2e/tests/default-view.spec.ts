/**
 * Default-view preference — when the user picks a default view in
 * Preferences, two navigation entry points must honour it:
 *
 *   1) Post-login: AppBoot redirects to `/w/<firstWorkspaceId>/<defaultView>`.
 *   2) Workspace switch: clicking a workspace tab in the WorkspaceBar
 *      lands on `/w/<wsId>/<defaultView>`, regardless of the view the user
 *      was on a moment ago.
 *
 * The pref previously offered a "chats" value that didn't map to any
 * route — `loadPrefs` now sanitises it back to the default
 * (PREFS_DEFAULTS.defaultView), which is also covered here.
 */
import { test, expect } from "../fixtures";

type DefaultView = "desk" | "tasks" | "context";

async function setDefaultViewPref(
  page: import("@playwright/test").Page,
  serverUrl: string,
  token: string,
  value: DefaultView | "chats",
): Promise<void> {
  // The blob is keyed `desk.prefs.<userId>` and only exists once the
  // user toggles a switch. Seed it directly so we can drive the
  // navigation tests without going through the modal each time.
  const me = (await (
    await fetch(`${serverUrl}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as { id: string };
  await page.evaluate(
    ({ userId, v }: { userId: string; v: string }) => {
      const key = `desk.prefs.${userId}`;
      const cur = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...cur, defaultView: v }));
      window.dispatchEvent(new CustomEvent("desk:prefs-changed"));
    },
    { userId: me.id, v: value },
  );
}

async function getWorkspaceId(serverUrl: string, token: string): Promise<string> {
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string }>;
  expect(ws.length).toBeGreaterThan(0);
  return ws[0].id;
}

test("post-login redirect lands on the default view", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const wsId = await getWorkspaceId(serverUrl, token);

  await setDefaultViewPref(loggedInPage, serverUrl, token, "tasks");

  // AppBoot only fires for unmatched paths. The fixture has already
  // landed us inside `/w/<id>/desk`; bouncing through `/` retriggers it.
  await loggedInPage.goto("/");
  await expect(loggedInPage).toHaveURL(new RegExp(`/w/${wsId}/tasks($|\\?)`), {
    timeout: 10_000,
  });

  await setDefaultViewPref(loggedInPage, serverUrl, token, "context");
  await loggedInPage.goto("/");
  await expect(loggedInPage).toHaveURL(
    new RegExp(`/w/${wsId}/context($|\\?)`),
    { timeout: 10_000 },
  );
});

test("workspace tab click jumps to the default view", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const wsId = await getWorkspaceId(serverUrl, token);
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as Array<{ id: string; name: string }>;

  await setDefaultViewPref(loggedInPage, serverUrl, token, "context");

  // Navigate to a non-default view so the click has somewhere to move
  // away from. Wait for: (a) the avatar to show real initials — proves
  // /me resolved, which is what `usePrefs` keys off; (b) the workspace
  // tab to mount — proves /workspaces resolved and we click the actual
  // tab, not the same-named sidebar nav. Both gates are needed because
  // the seed workspace is named "Desk", which collides with the sidebar
  // "Desk" view nav button if you key off accessible name alone.
  await loggedInPage.goto(`/w/${wsId}/tasks`);
  await expect(loggedInPage.getByTestId("account-avatar")).toBeVisible();
  await expect(loggedInPage.getByTestId("account-avatar")).not.toHaveText("…");
  await expect(loggedInPage).toHaveURL(new RegExp(`/w/${wsId}/tasks`));

  const tab = loggedInPage.getByTestId(`workspace-tab-${ws[0].id}`);
  await expect(tab).toBeVisible();
  await tab.click();

  await expect(loggedInPage).toHaveURL(
    new RegExp(`/w/${wsId}/context($|\\?)`),
    { timeout: 5_000 },
  );
});

test("stale 'chats' value is sanitised back to the default view", async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const wsId = await getWorkspaceId(serverUrl, token);

  // 'chats' was a valid pref value in an earlier release. The shape has
  // since narrowed to RouteView (pinned|desk|tasks|context); loadPrefs
  // must not propagate the stale value into the URL — it falls back to
  // PREFS_DEFAULTS.defaultView (currently 'tasks').
  await setDefaultViewPref(loggedInPage, serverUrl, token, "chats");
  await loggedInPage.goto("/");
  await expect(loggedInPage).toHaveURL(new RegExp(`/w/${wsId}/tasks($|\\?)`), {
    timeout: 10_000,
  });
});
