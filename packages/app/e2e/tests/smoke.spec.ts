import { test, expect } from "../fixtures";

test("disposable server health check", async ({ serverUrl }) => {
  const res = await fetch(`${serverUrl}/`);
  expect(res.status).toBe(200);
});

test("seeded login returns a session token", async ({ token }) => {
  expect(token).toMatch(/^ses_/);
});

test("Vite preview serves the app for a logged-in user", async ({
  loggedInPage,
}) => {
  await expect(loggedInPage.locator("#root")).toBeAttached();
});
