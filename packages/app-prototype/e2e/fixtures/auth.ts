import type { BrowserContext, Page } from "@playwright/test";

/** Default seeded creds, matching the Playwright server fixture. */
export const SEED_USERNAME = "e2e";
export const SEED_PASSWORD = "e2e";

export async function fetchToken(
  serverUrl: string,
  username = SEED_USERNAME,
  password = SEED_PASSWORD,
): Promise<string> {
  const res = await fetch(`${serverUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

/**
 * Inject a pre-obtained token into the page's sessionStorage so the React
 * app's ensureSession() short-circuits and does not pop a window.prompt().
 */
export async function seedSessionToken(
  context: BrowserContext,
  appOrigin: string,
  token: string,
): Promise<void> {
  await context.addInitScript(
    ({ appOrigin, token }) => {
      // Only inject for the app origin.
      if (window.location.origin !== appOrigin) return;
      try {
        sessionStorage.setItem("desk.session.token", token);
      } catch {
        /* some test harness pages block storage — ignore. */
      }
    },
    { appOrigin, token },
  );
}

export async function logInAndNavigate(
  page: Page,
  appUrl: string,
  serverUrl: string,
): Promise<string> {
  const token = await fetchToken(serverUrl);
  await seedSessionToken(page.context(), new URL(appUrl).origin, token);
  await page.goto(appUrl);
  return token;
}
