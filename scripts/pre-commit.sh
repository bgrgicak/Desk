#!/bin/sh
# Pre-commit: typecheck (every workspace, including the app's
# `tsc -b` with noUnusedLocals) + lint + unit tests. Integration/e2e
# tests are excluded here because they need Docker, real services, or
# long-running model calls.
#
# Lint is in the hook because the app's strict tsc-b catches unused
# imports and the same things eslint would catch — running lint here
# closes the gap between local typecheck and the CI Typecheck job,
# which also runs `npm run lint`. The extra cost is ~5s.
set -e
npm rebuild better-sqlite3 --silent
npm run typecheck
npm run lint
npx vitest run \
  --exclude '**/integration/**' \
  --exclude '**/*.integration.test.ts' \
  --exclude '**/e2e/**' \
  --exclude '**/e2e.test.ts' \
  --passWithNoTests
