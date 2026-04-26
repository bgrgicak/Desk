import { test as base, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SEED_PASSWORD,
  SEED_USERNAME,
  fetchToken,
  seedSessionToken,
} from "./auth";

export { expect };

interface Fixtures {
  serverUrl: string;
  token: string;
  loggedInPage: import("@playwright/test").Page;
}

interface Handle {
  server: { url: string };
  vite: { url: string };
}

function readHandle(): Handle {
  const file = path.join(os.tmpdir(), "desk-app-e2e-handle.json");
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw) as Handle;
}

/**
 * Playwright `test` extended with server URL + auth helpers.
 *
 * The disposable desk-server is started once by `globalSetup` and its URL
 * is persisted in /tmp/desk-app-e2e-handle.json. Each test gets a fresh
 * login token.
 */
export const test = base.extend<Fixtures>({
  serverUrl: async ({}, use) => {
    await use(readHandle().server.url);
  },

  token: async ({ serverUrl }, use) => {
    await use(await fetchToken(serverUrl, SEED_USERNAME, SEED_PASSWORD));
  },

  loggedInPage: async ({ page, baseURL, token }, use) => {
    if (!baseURL) throw new Error("playwright baseURL is required");
    await seedSessionToken(page.context(), new URL(baseURL).origin, token);
    await page.goto(baseURL);
    await use(page);
  },
});
