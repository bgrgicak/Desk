import { defineConfig, devices } from "@playwright/test";

const VITE_PORT = 5179;
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
  webServer: {
    // Vite reads DESK_API_URL from env (set by globalSetup) and proxies
    // /api and /ws to the disposable desk-server.
    command: `vite --port ${VITE_PORT} --strictPort`,
    url: VITE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
