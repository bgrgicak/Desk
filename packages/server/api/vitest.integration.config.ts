import { defineConfig } from "vitest/config";

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
    include: ["test/**/*.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
