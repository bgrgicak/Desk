import { defineConfig } from "vitest/config";

// Default `test` run for @roomy-ai/db has no unit tests — the integration suite
// under test/ requires Postgres and runs via `test:integration` in the VM.
export default defineConfig({
  // Resolve workspace deps via the `@roomy-ai/dev` export condition so vitest
  // pulls TS source from each package's src/ directly instead of stale
  // dist/ builds. Mirrors the root vitest.config.ts.
  resolve: { conditions: ["@roomy-ai/dev"] },
  ssr: {
    resolve: {
      conditions: ["@roomy-ai/dev"],
      externalConditions: ["@roomy-ai/dev"],
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
