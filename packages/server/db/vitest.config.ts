import { defineConfig } from "vitest/config";

// Default `test` run for @desk/db has no unit tests — the integration suite
// under test/ requires Postgres and runs via `test:integration` in the VM.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
