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
    root: import.meta.dirname,
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
