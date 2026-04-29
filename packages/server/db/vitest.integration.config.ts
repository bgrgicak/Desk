import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolve workspace deps via the `@desk/dev` export condition so vitest
  // pulls TS source from each package's src/ directly instead of stale
  // dist/ builds. Mirrors the root vitest.config.ts.
  resolve: { conditions: ["@desk/dev"] },
  ssr: {
    resolve: {
      conditions: ["@desk/dev"],
      externalConditions: ["@desk/dev"],
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
