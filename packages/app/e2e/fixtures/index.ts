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
  serverHome: string;
  /** Path the spawned server reads for its host-managed Codex auth file. */
  codexAuthPath: string;
  token: string;
  loggedInPage: import("@playwright/test").Page;
}

interface Handle {
  server: { url: string; home: string };
  vite: { url: string };
  codexAuthPath: string;
}

function readHandle(): Handle {
  const file = path.join(os.tmpdir(), "roomy-app-e2e-handle.json");
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw) as Handle;
}

/**
 * Playwright `test` extended with server URL + auth helpers.
 *
 * The disposable roomy-server is started once by `globalSetup` and its URL
 * is persisted in /tmp/roomy-app-e2e-handle.json. Each test gets a fresh
 * login token.
 */
export const test = base.extend<Fixtures>({
  serverUrl: async ({}, use) => {
    await use(readHandle().server.url);
  },

  serverHome: async ({}, use) => {
    await use(readHandle().server.home);
  },

  codexAuthPath: async ({}, use) => {
    await use(readHandle().codexAuthPath);
  },

  token: async ({ serverUrl }, use) => {
    await use(await fetchToken(serverUrl, SEED_USERNAME, SEED_PASSWORD));
  },

  loggedInPage: async ({ page, baseURL, serverUrl, token }, use) => {
    if (!baseURL) throw new Error("playwright baseURL is required");
    await seedSessionToken(page.context(), new URL(baseURL).origin, token);
    // The root path now renders the multi-workspace Home picker rather
    // than auto-redirecting into the first room. Pre-resolve the seeded
    // workspace and land directly inside it so existing specs can keep
    // assuming the per-room sidebar (Tasks / Library / Customize) is
    // mounted right after login.
    const workspaces = (await (
      await fetch(`${serverUrl}/workspaces`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as Array<{ id: string }>;
    const wsId = workspaces[0]?.id;
    const landing = wsId
      ? new URL(`/w/${wsId}/pinned?chat=new`, baseURL).toString()
      : baseURL;
    await page.goto(landing);
    await use(page);
  },
});
