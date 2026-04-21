import { defineConfig } from "vitest/config";
import * as fs from "node:fs";
import * as path from "node:path";

// Load .env from repo root so ANTHROPIC_API_KEY / DATABASE_URL are available
const envPath = path.resolve(import.meta.dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/test/e2e/**",
      "packages/app/**",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Serialize file execution: scheduler integration tests share system-level
    // state (atq, crontab) and race when run in parallel workers.
    fileParallelism: false,
  },
});
