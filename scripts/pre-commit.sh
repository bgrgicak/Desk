#!/bin/sh
# Pre-commit: typecheck + unit tests (integration tests excluded — they need Docker and are slow).
set -e
npm rebuild better-sqlite3 --silent
npm run typecheck
npx vitest run --exclude '**/integration/**' --exclude '**/e2e/**' --passWithNoTests
