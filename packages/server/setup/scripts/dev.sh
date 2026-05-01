#!/usr/bin/env bash
# Starts the full dev stack on the host:
#   - desk-server in tsx-watch mode on http://127.0.0.1:${PORT:-35138}/
#   - app Vite dev server on http://127.0.0.1:${DESK_APP_PORT:-5173}/
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

# 2. Ensure DESK_SECRET_KEY is persisted in the repo .env (gitignored).
#    The DB encryption module prefers DESK_SECRET_KEY over its on-disk
#    fallback at $DESK_HOME/secret.key, so pinning it here keeps the
#    user_settings.provider_keys_encrypted blob decryptable across
#    host reinstalls and ~/Desk wipes.
ENV_FILE="${REPO_ROOT}/.env"
desk_secret_key=""
if [ -f "$ENV_FILE" ]; then
  desk_secret_key="$(grep -E '^DESK_SECRET_KEY=' "$ENV_FILE" 2>/dev/null | tail -n1 \
    | sed -E 's/^DESK_SECRET_KEY=//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/')"
fi
if [ -z "$desk_secret_key" ]; then
  echo "==> Generating DESK_SECRET_KEY (32 bytes, base64) → ${ENV_FILE}"
  desk_secret_key="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
  touch "$ENV_FILE"
  if [ -s "$ENV_FILE" ] && [ -n "$(tail -c1 "$ENV_FILE")" ]; then
    printf '\n' >> "$ENV_FILE"
  fi
  printf 'DESK_SECRET_KEY=%s\n' "$desk_secret_key" >> "$ENV_FILE"
fi

# 3. Ensure ~/Desk/ exists. desk-server's main.ts mkdirs the rest of the
#    layout (.database, workspaces, .trash, .tmp, backups) on boot.
DESK_HOME_DEFAULT="${HOME}"
mkdir -p "${DESK_HOME_DEFAULT}/Desk"

# 4. Kill stale processes holding our ports from a previous run.
for port in 5173 35138; do
  if lsof -ti ":${port}" >/dev/null 2>&1; then
    echo "==> Port ${port} in use — killing stale process…"
    lsof -ti ":${port}" | xargs kill -9 2>/dev/null || true
  fi
done

# 5. Start desk-server (tsx watch) in the background, with auto-restart on crash.
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
  export NODE_OPTIONS="${NODE_OPTIONS:-} --conditions @agent-desk/dev --no-warnings"
  export PORT="${PORT:-35138}"
  export DESK_HOME="${DESK_HOME:-$DESK_HOME_DEFAULT}"

  MAX_SERVER_RESTARTS=3
  _restarts=0
  while true; do
    npx tsx watch packages/server/api/src/main.ts
    _ec=$?
    # 0 = clean shutdown; 130 = SIGINT; 143 = SIGTERM — don't retry on those.
    [ "$_ec" -eq 0 ] || [ "$_ec" -eq 130 ] || [ "$_ec" -eq 143 ] && break
    _restarts=$((_restarts + 1))
    if [ "$_restarts" -ge "$MAX_SERVER_RESTARTS" ]; then
      echo "==> desk-server: crashed ${MAX_SERVER_RESTARTS} times in a row — giving up." >&2
      exit "$_ec"
    fi
    echo "==> desk-server: crashed (attempt ${_restarts}/${MAX_SERVER_RESTARTS}), restarting in 2s…" >&2
    sleep 2
  done
) &
SERVER_PID=$!

# 6. Start vite (app) in the background.
(
  cd "$REPO_ROOT"
  export DESK_API_URL="${DESK_API_URL:-http://127.0.0.1:35138}"
  exec npm -w @agent-desk/app run dev
) &
VITE_PID=$!

SERVER_PORT="${PORT:-35138}"
APP_PORT="${DESK_APP_PORT:-5173}"

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

echo "==> desk-server starting (pid $SERVER_PID) on http://127.0.0.1:${SERVER_PORT}/"
echo "==> Vite dev server starting (pid $VITE_PID) on http://127.0.0.1:${APP_PORT}/"
echo "==> Ctrl+C stops both."

# Wait for either child to exit, then trigger cleanup.
# Note: `wait -n` requires bash 4.3+, but macOS ships with bash 3.2 — so we
# poll instead. Exits when either PID dies; the EXIT trap then kills the other.
while kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$VITE_PID" 2>/dev/null; do
  sleep 1
done
