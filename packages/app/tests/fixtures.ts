/**
 * Playwright test fixtures with auto-login helper.
 * The global-setup.ts handles DB, API server, and static file serving.
 */
import { test as base, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, ".test-state.json");

function readState(): { appPort: number } {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

const SEED_USER = "testuser";
const SEED_PASS = "testpass";

export const test = base.extend<{
  /** Log in as the seed user. Call this at the start of each test. */
  login: () => Promise<void>;
}>({
  baseURL: async ({}, use) => {
    const state = readState();
    await use(`http://127.0.0.1:${state.appPort}`);
  },

  login: async ({ page, baseURL }, use) => {
    async function doLogin() {
      await page.goto(baseURL!);
      await page.getByLabel("Username").fill(SEED_USER);
      await page.getByLabel("Password").fill(SEED_PASS);
      await page.getByRole("button", { name: "Log in" }).click();
      await page.getByRole("heading", { name: "Desk" }).waitFor();
    }
    await use(doLogin);
  },
});

export { expect, SEED_USER, SEED_PASS };
