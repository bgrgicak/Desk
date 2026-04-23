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
  _appOrigin: string,
  token: string,
): Promise<void> {
  // Playwright runs init scripts on every frame including about:blank. We
  // only care about the app's origin — sessionStorage accesses from other
  // origins are silently caught. The origin guard added earlier was buggy
  // because window.location.origin is evaluated at init-script time (so it
  // resolves to about:blank before the page navigates).
  await context.addInitScript((token) => {
    try {
      sessionStorage.setItem("desk.session.token", token);
    } catch {
      /* ignore — about:blank or storage-denied context */
    }
  }, token);
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
