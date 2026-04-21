import { defineConfig } from "vitest/config";
import * as path from "node:path";

export default defineConfig({
  test: {
    root: path.dirname(new URL(import.meta.url).pathname),
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
