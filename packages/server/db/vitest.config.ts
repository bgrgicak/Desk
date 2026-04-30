import { defineConfig } from "vitest/config";

// Default `test` run for @agent-desk/db has no unit tests — the integration suite
// under test/ requires Postgres and runs via `test:integration` in the VM.
export default defineConfig({
  // Resolve workspace deps via the `@agent-desk/dev` export condition so vitest
  // pulls TS source from each package's src/ directly instead of stale
  // dist/ builds. Mirrors the root vitest.config.ts.
  resolve: { conditions: ["@agent-desk/dev"] },
  ssr: {
    resolve: {
      conditions: ["@agent-desk/dev"],
      externalConditions: ["@agent-desk/dev"],
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
