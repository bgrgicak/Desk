#!/bin/sh
# Pre-commit: typecheck + lint + unit tests. Integration/e2e tests are
# excluded here because they need Docker, real services, or long-running
# model calls.
set -e
npm rebuild better-sqlite3 --silent
npm run typecheck
# Lint everything that isn't packages/app (the app keeps its own
# eslint config — it surfaces via `npm -w @agent-desk/app run lint`,
# which CI runs separately).
npm run lint
npx vitest run \
  --exclude '**/integration/**' \
  --exclude '**/*.integration.test.ts' \
  --exclude '**/e2e/**' \
  --exclude '**/e2e.test.ts' \
  --passWithNoTests
