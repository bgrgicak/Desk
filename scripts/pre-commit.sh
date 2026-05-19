#!/bin/sh
# Pre-commit: typecheck + unit tests. Integration/e2e tests are
# excluded here because they need Docker, real services, or long-running
# model calls.
#
# Lint (`npm run lint`) is deliberately NOT run in the hook —
# eslint --max-warnings on the full tree adds ~10s+ per commit and the
# CI Typecheck job already enforces it. Developers who want belt+
# suspenders can run `npm run lint` manually.
set -e
npm rebuild better-sqlite3 --silent
npm run typecheck
npx vitest run \
  --exclude '**/integration/**' \
  --exclude '**/*.integration.test.ts' \
  --exclude '**/e2e/**' \
  --exclude '**/e2e.test.ts' \
  --passWithNoTests
