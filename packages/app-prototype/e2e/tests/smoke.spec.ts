import { test, expect } from "../fixtures";

test("disposable server health check", async ({ serverUrl }) => {
  const res = await fetch(`${serverUrl}/`);
  expect(res.status).toBe(200);
});

test("seeded login returns a session token", async ({ token }) => {
  expect(token).toMatch(/^ses_/);
});

test("Vite dev server serves the app", async ({ page, baseURL }) => {
  await page.goto(baseURL!);
  // Only assertion: the root element is present. This confirms the Vite
  // webServer is running and serving index.html.
  await expect(page.locator("#root")).toBeAttached();
});
