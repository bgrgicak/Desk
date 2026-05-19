import { defineConfig, devices } from "@playwright/test";

// Both the desk-server (under test) and the Vite preview server are
// started by globalSetup, because Playwright's built-in webServer starts
// BEFORE globalSetup — which means the DESK_API_URL env var the Vite
// proxy config reads would be unset and it would proxy to the developer's
// local :3000. See e2e/fixtures/global-server.ts.
const VITE_PORT = Number(process.env.DESK_E2E_VITE_PORT ?? 5179);
const VITE_URL = `http://127.0.0.1:${VITE_PORT}`;

export default defineConfig({
  testDir: "./e2e/tests",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/fixtures/global-server.ts",
  globalTeardown: "./e2e/fixtures/global-teardown.ts",
  use: {
    baseURL: VITE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
