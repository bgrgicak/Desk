import { defineConfig } from "vitest/config";
import * as fs from "node:fs";
import * as path from "node:path";

// Load .env from repo root so DESK_SECRET_KEY / DATABASE_URL are available
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
  // Resolve workspace deps via the `@agent-desk/dev` export condition so Vite
  // pulls TS source from each package's src/ directly. Without this it
  // walks the default `import` condition (e.g. @agent-desk/shared/dist/index.js),
  // which only exists after a separate `tsc` build of every package —
  // fine locally for anyone who has built once, broken on fresh CI
  // checkouts where `npm ci` does not run package build scripts. The
  // `ssr.resolve.externalConditions` key is the one that matters for
  // workspace-as-node_modules deps under vitest's SSR loader.
  resolve: {
    alias: {
      // Mirror the `@/` path alias from packages/app/vite.config.ts
      // so that app unit tests (e.g. store/ws/middleware.test.ts) can
      // import from `@/store/…`, `@/auth/…`, etc.
      "@": path.resolve(import.meta.dirname, "packages/app/src"),
    },
    conditions: ["@agent-desk/dev"],
  },
  ssr: {
    resolve: {
      conditions: ["@agent-desk/dev"],
      externalConditions: ["@agent-desk/dev"],
    },
  },
  test: {
    // Suppress node:sqlite's "experimental feature" warning — it's a known
    // limitation of Node 23; the module is stable enough for production use.
    env: { NODE_OPTIONS: "--no-warnings" },
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/test/e2e/**",
      "packages/app/e2e/**",
      ".worktrees/**",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Serialize file execution: scheduler integration tests share system-level
    // state (atq, crontab) and race when run in parallel workers.
    fileParallelism: false,
  },
});
