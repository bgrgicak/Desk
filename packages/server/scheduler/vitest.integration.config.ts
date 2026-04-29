import { defineConfig } from "vitest/config";
import * as path from "node:path";

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
    root: path.dirname(new URL(import.meta.url).pathname),
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
