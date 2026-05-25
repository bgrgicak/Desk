#!/usr/bin/env bash
# Starts the full dev stack on the host:
#   - roomy-server in tsx-watch mode on http://127.0.0.1:${PORT:-35139}/
#   - app Vite dev server on http://127.0.0.1:${ROOMY_APP_PORT:-5174}/
#
# Dev uses ports 35139 (API) and 5174 (app) by default so a published
# production install (35138 / 5173) can run alongside the dev server.
#
# No VM, no systemd, no port forwards. One Ctrl+C kills both via the
# process-group trap below.
set -uo pipefail

# Enable job control so the backgrounded subshells become their own
# process-group leaders. Without this, kill -- -PGID can't reach
# tsx-watch / vite children and they survive Ctrl+C, binding ports
# 5174+ / 8081+ on subsequent runs.
set -m

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

# 0. Pin host Node to the major version in .nvmrc.
NVMRC_MAJOR="$(awk -F. 'NR==1{gsub(/^v/,"",$1); print $1}' "${REPO_ROOT}/.nvmrc" 2>/dev/null || true)"
HOST_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [ -n "$NVMRC_MAJOR" ] && [ "$HOST_MAJOR" != "$NVMRC_MAJOR" ]; then
  echo "ERROR: host Node is v${HOST_MAJOR:-?} but .nvmrc requires v${NVMRC_MAJOR}." >&2
  echo "       Run \`nvm install ${NVMRC_MAJOR} && nvm use\` (or your equivalent) and retry." >&2
  exit 1
fi

# 1. Ensure workspace deps are installed.
if [ ! -x "${REPO_ROOT}/node_modules/.bin/vite" ] || [ ! -x "${REPO_ROOT}/node_modules/.bin/tsx" ]; then
  echo "==> Installing workspace dependencies"
  (cd "$REPO_ROOT" && npm install --include=optional --no-audit --no-fund)
fi

# 2. (removed) ROOMY_VAULT_PASSWORD no longer exists — vault passwords are
#    chosen through the signup wizard and unlocked via the VaultDialog.

ENV_FILE="${REPO_ROOT}/.env"

# 3. Ensure ~/Roomy/ exists. roomy-server's main.ts mkdirs the rest of the
#    layout (.database, workspaces, .trash, .tmp, backups) on boot.
ROOMY_HOME_DEFAULT="${HOME}/Roomy"
mkdir -p "${ROOMY_HOME_DEFAULT}"

# 3a. Build any built-in app that is missing its dist/. Source-mode dev reads
#     fragments directly from packages/apps/<name>.app/dist/, which is
#     only ever produced by an explicit `npm run build`. Without this step,
#     a freshly pulled new app (sources only, no dist) silently 404s on
#     attach-artifact.
ROOMY_APPS_ROOT="${REPO_ROOT}/packages/apps"
if [ -d "${ROOMY_APPS_ROOT}" ]; then
  for app_dir in "${ROOMY_APPS_ROOT}"/*.app; do
    [ -d "${app_dir}" ] || continue
    if [ ! -d "${app_dir}/dist" ]; then
      echo "==> Building built-in app: $(basename "${app_dir}")"
      (cd "$REPO_ROOT" && npm -w @roomy-ai/apps run build)
      break
    fi
  done
fi

# 3b. Rebuild the sandbox docker image when its inputs (sandbox-cli source,
#     Dockerfile, app-scaffold manifests) have changed. Skipped silently
#     when the existing image's `roomy.fingerprint` label still matches.
if [ -z "${ROOMY_SKIP_SANDBOX_BUILD:-}" ]; then
  bash "${SCRIPT_DIR}/ensure-sandbox-image.sh" || {
    echo "==> sandbox image rebuild failed; continuing with existing image." >&2
  }
fi

# 4. Kill stale processes holding our ports from a previous run.
for port in 5174 35139; do
  if lsof -ti ":${port}" >/dev/null 2>&1; then
    echo "==> Port ${port} in use — killing stale process…"
    lsof -ti ":${port}" | xargs kill -9 2>/dev/null || true
  fi
done

# 5. Start roomy-server (tsx watch) in the background, with auto-restart on crash.
#    tsx watch exits when the Node process it runs also exits (e.g. on unhandled
#    error). We restart up to MAX_SERVER_RESTARTS times before giving up, so a
#    transient startup failure (e.g. a migration race) doesn't kill the whole dev
#    session. A clean exit (code 0 or signal termination) stops the loop.
(
  cd "$REPO_ROOT"
  set -a
  # shellcheck disable=SC1090
  [ -f "$ENV_FILE" ] && . "$ENV_FILE"
  set +a
  export NODE_OPTIONS="${NODE_OPTIONS:-} --conditions=@roomy-ai/dev --no-warnings"
  export PORT="${PORT:-35139}"
  export ROOMY_HOME="${ROOMY_HOME:-$ROOMY_HOME_DEFAULT}"

  MAX_SERVER_RESTARTS=3
  _restarts=0
  while true; do
    npx tsx watch --conditions=@roomy-ai/dev packages/server/api/src/main.ts
    _ec=$?
    # 0 = clean shutdown; 130 = SIGINT; 143 = SIGTERM — don't retry on those.
    [ "$_ec" -eq 0 ] || [ "$_ec" -eq 130 ] || [ "$_ec" -eq 143 ] && break
    _restarts=$((_restarts + 1))
    if [ "$_restarts" -ge "$MAX_SERVER_RESTARTS" ]; then
      echo "==> roomy-server: crashed ${MAX_SERVER_RESTARTS} times in a row — giving up." >&2
      exit "$_ec"
    fi
    echo "==> roomy-server: crashed (attempt ${_restarts}/${MAX_SERVER_RESTARTS}), restarting in 2s…" >&2
    sleep 2
  done
) &
SERVER_PID=$!

# 6. Start vite (app) in the background.
(
  cd "$REPO_ROOT"
  export NODE_OPTIONS="${NODE_OPTIONS:-} --conditions=@roomy-ai/dev --no-warnings"
  export ROOMY_API_URL="${ROOMY_API_URL:-http://127.0.0.1:35139}"
  export ROOMY_APP_PORT="${ROOMY_APP_PORT:-5174}"
  exec npm -w @roomy-ai/app run dev
) &
VITE_PID=$!

SERVER_PORT="${PORT:-35139}"
APP_PORT="${ROOMY_APP_PORT:-5174}"

cleanup() {
  if kill -0 "$VITE_PID" 2>/dev/null; then
    kill -TERM -- "-$VITE_PID" 2>/dev/null || kill -TERM "$VITE_PID" 2>/dev/null || true
  fi
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM -- "-$SERVER_PID" 2>/dev/null || kill -TERM "$SERVER_PID" 2>/dev/null || true
  fi
  sleep 1
  kill -KILL -- "-$VITE_PID" 2>/dev/null || true
  kill -KILL -- "-$SERVER_PID" 2>/dev/null || true
  # Belt-and-braces: anything left on our ports.
  for port in "$APP_PORT" "$SERVER_PORT"; do
    lsof -ti ":${port}" 2>/dev/null | xargs kill -9 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

echo "==> roomy-server starting (pid $SERVER_PID) on http://127.0.0.1:${SERVER_PORT}/"
echo "==> Vite dev server starting (pid $VITE_PID) on http://127.0.0.1:${APP_PORT}/"
echo "==> Ctrl+C stops both."

# Wait for either child to exit, then trigger cleanup.
# Note: `wait -n` requires bash 4.3+, but macOS ships with bash 3.2 — so we
# poll instead. Exits when either PID dies; the EXIT trap then kills the other.
while kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$VITE_PID" 2>/dev/null; do
  sleep 1
done
