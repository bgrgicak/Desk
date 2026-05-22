#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

export ROOMY_DEV="${ROOMY_DEV:-1}"
if [ -z "${ROOMY_HOME:-}" ]; then
  ROOMY_HOME=$(mktemp -d)
  export ROOMY_HOME
fi
export ROOMY_DB_PATH="${ROOMY_DB_PATH:-$ROOMY_HOME/.database/roomy.sqlite3}"

mkdir -p "$ROOMY_HOME" "$(dirname "$ROOMY_DB_PATH")"

pids=""
cleanup() {
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
  fi
}
trap cleanup INT TERM

wait_for() {
  name=$1
  pid=$2
  if wait "$pid"; then
    printf '[ci:local] %s passed\n' "$name"
  else
    status=$?
    printf '[ci:local] %s failed with exit code %s\n' "$name" "$status" >&2
    return 1
  fi
}

wait_group() {
  failed=0
  while [ "$#" -gt 0 ]; do
    name=$1
    pid=$2
    shift 2
    if ! wait_for "$name" "$pid"; then
      failed=1
    fi
  done
  return "$failed"
}

printf '[ci:local] Installing dependencies\n'
npm ci

printf '[ci:local] Running first parallel phase\n'
(npm run typecheck && npm --prefix packages/desktop install --ignore-scripts && npm --prefix packages/desktop run typecheck) &
typecheck_pid=$!
pids="$pids $typecheck_pid"

(
  npm run build --workspace=@roomy-ai/sandbox-cli
  docker build -f packages/server/runtime/Dockerfile.sandbox -t roomy/sandbox:v1 .
) &
sandbox_pid=$!
pids="$pids $sandbox_pid"

npm -w @roomy-ai/app exec -- playwright install chromium &
playwright_install_pid=$!
pids="$pids $playwright_install_pid"

wait_group \
  typecheck "$typecheck_pid" \
  sandbox-image "$sandbox_pid" \
  playwright-install "$playwright_install_pid"

printf '[ci:local] Running second parallel phase\n'
npx vitest run --passWithNoTests --retry=2 &
vitest_pid=$!
pids="$pids $vitest_pid"

npx nx build @roomy-ai/api &
api_build_pid=$!
pids="$pids $api_build_pid"

wait_group \
  vitest "$vitest_pid" \
  api-build "$api_build_pid"

printf '[ci:local] Running Playwright e2e\n'
npm -w @roomy-ai/app run test:e2e -- --retries=2

trap - INT TERM
printf '[ci:local] Complete\n'
