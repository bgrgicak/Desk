/**
 * Slice 11 — account / providers / models.
 *
 * The account menu's Preferences entry has no onClick handler today
 * (matrix §2.9), so there's no UI surface to exercise. Plan §6.11 has
 * this slice as "wire in-store, TODO in-UI". This spec asserts the
 * RTK-Query-compatible endpoints behave correctly end-to-end through
 * the Vite proxy.
 *
 * The in-UI entry points (Preferences → Account / Providers / Models)
 * should be hung on these endpoints in a follow-up that also designs
 * the screens themselves — scope the plan explicitly calls out as
 * out-of-scope for app-api-integration.
 */
import { test, expect } from "../fixtures";

test("/me is reachable through the Vite proxy", async ({
  loggedInPage,
  serverUrl: _serverUrl,
  token,
}) => {
  const res = await loggedInPage.evaluate(async (t) => {
    const r = await fetch("/api/me", {
      headers: { Authorization: `Bearer ${t}` },
    });
    return { status: r.status, body: await r.json() };
  }, token);
  expect(res.status).toBe(200);
  expect((res.body as { username: string }).username).toBe("e2e");
});

test("/me/providers is reachable via GET", async ({
  loggedInPage,
  token,
}) => {
  const get = await loggedInPage.evaluate(async (t) => {
    const r = await fetch("/api/me/providers", {
      headers: { Authorization: `Bearer ${t}` },
    });
    return { status: r.status, body: await r.json() };
  }, token);
  expect(get.status).toBe(200);
  // The seeded user has no keys stored — every known provider is null.
  const providers = (get.body as { providers: Record<string, string | null> })
    .providers;
  expect(providers).toHaveProperty("GEMINI_API_KEY");
  expect(providers.GEMINI_API_KEY).toBeNull();
});

test("/tools/models returns a list", async ({ loggedInPage, token }) => {
  const res = await loggedInPage.evaluate(async (t) => {
    const r = await fetch("/api/tools/models", {
      headers: { Authorization: `Bearer ${t}` },
    });
    return { status: r.status, body: await r.json() };
  }, token);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
});
