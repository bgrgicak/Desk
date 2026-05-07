#!/bin/sh
# Pre-commit: typecheck + unit tests. Integration/e2e tests are excluded here
# because they need Docker, real services, or long-running model calls.
set -e
npm rebuild better-sqlite3 --silent
npm run typecheck
npx vitest run \
  --exclude '**/integration/**' \
  --exclude '**/*.integration.test.ts' \
  --exclude '**/e2e/**' \
  --exclude '**/e2e.test.ts' \
  --passWithNoTests
