import { test, expect } from "../fixtures";

test("captures responsive sidebar states", async ({ loggedInPage }, testInfo) => {
  const capture = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`);
    await loggedInPage.screenshot({ path, fullPage: true });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };

  await loggedInPage.setViewportSize({ width: 390, height: 844 });
  await loggedInPage.reload();
  await expect(loggedInPage.locator("#root")).toBeVisible();
  await expect(loggedInPage.locator('svg[aria-label="Desk"]')).toBeHidden();
  await capture("desk-sidebar-mobile-closed");

  await loggedInPage.locator('[data-slot="sidebar-inset"] [data-slot="sidebar-trigger"]').click();
  const sidebar = loggedInPage.locator('[data-slot="sidebar-container"]');
  await expect(sidebar).toBeVisible();
  await loggedInPage.waitForTimeout(300);
  const sidebarBox = await sidebar.boundingBox();
  expect(sidebarBox?.x).toBeLessThanOrEqual(20);
  expect(sidebarBox?.width).toBeGreaterThan(220);
  await capture("desk-sidebar-mobile-open");

  await loggedInPage.locator('[data-slot="sidebar"] [data-slot="sidebar-trigger"]').click();
  await expect(sidebar).not.toBeInViewport();

  await loggedInPage.setViewportSize({ width: 1280, height: 900 });
  await loggedInPage.reload();
  await expect(loggedInPage.locator("#root")).toBeVisible();
  await expect(loggedInPage.locator('svg[aria-label="Desk"]')).toBeVisible();
  await capture("desk-sidebar-desktop");
});

test("mobile chat layout does not overflow horizontally", async ({ loggedInPage }) => {
  await loggedInPage.setViewportSize({ width: 390, height: 844 });
  await loggedInPage.reload();
  await expect(loggedInPage.locator("#root")).toBeVisible();

  const metrics = await loggedInPage.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    chatWidth: document.querySelector('[data-slot="sidebar-inset"]')?.getBoundingClientRect().width ?? 0,
  }));

  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.bodyWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.chatWidth).toBeLessThanOrEqual(metrics.viewportWidth);
});

test("mobile app shell stays within short viewport height", async ({ loggedInPage }) => {
  await loggedInPage.setViewportSize({ width: 390, height: 540 });
  await loggedInPage.reload();
  await expect(loggedInPage.locator("#root")).toBeVisible();

  const metrics = await loggedInPage.evaluate(() => {
    const root = document.querySelector("#root")?.getBoundingClientRect();
    const appShell = document.querySelector("#root > div")?.getBoundingClientRect();
    return {
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      bodyHeight: document.body.scrollHeight,
      rootHeight: root?.height ?? 0,
      appShellHeight: appShell?.height ?? 0,
    };
  });

  expect(metrics.documentHeight).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.bodyHeight).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.rootHeight).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.appShellHeight).toBeLessThanOrEqual(metrics.viewportHeight);
});
