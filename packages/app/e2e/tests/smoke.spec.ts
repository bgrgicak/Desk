import { test, expect } from "../fixtures";

test("disposable server health check", async ({ serverUrl }) => {
  const res = await fetch(`${serverUrl}/`);
  expect(res.status).toBe(200);
});

test("seeded login returns a session token", async ({ token }) => {
  expect(token).toMatch(/^ses_/);
});

test("auto-login endpoint respects the e2e opt-out", async ({ serverUrl }) => {
  const res = await fetch(`${serverUrl}/auth/auto-login`, { method: "POST" });
  // The shared e2e server disables auto-login so login/sign-out specs can
  // exercise the manual screen. This assertion keeps that opt-out explicit;
  // production/dev leave DESK_AUTO_LOGIN on by default.
  expect(res.status).toBe(401);
});

test("Vite preview serves the app for a logged-in user", async ({
  loggedInPage,
}) => {
  await expect(loggedInPage.locator("#root")).toBeAttached();
});
