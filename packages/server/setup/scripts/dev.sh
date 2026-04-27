#!/usr/bin/env bash
# Starts the full dev stack:
#   - app-prototype Vite dev server on the host (http://localhost:5173/)
#   - desk-server in tsx-watch mode inside the VM, streaming logs
#
# Ctrl+C shuts both down cleanly — vite gets SIGTERM, dev-override.sh
# reverts the systemd override on its own trap.
set -uo pipefail

# Enable job control so the backgrounded subshell becomes its own
# process-group leader. Without this, kill -- -PGID can't reach the
# vite/node children and they survive Ctrl+C, binding ports 5174+
# on subsequent runs.
set -m

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
VM_SH="${SCRIPT_DIR}/vm.sh"
INSTANCE="${DESK_INSTANCE:-dev}"
NAME="desk-${INSTANCE}"

# Returns 0 if the rolldown native binding for the current OS/arch is present.
rolldown_binding_ok() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"
  find "${REPO_ROOT}/node_modules/@rolldown" -maxdepth 2 \
    -path "*binding-${os}-${arch}*" -name "*.node" 2>/dev/null | grep -q .
}

# Removes every workspace node_modules + package-lock.json so npm re-resolves
# optional deps for the current platform from scratch.
full_clean() {
  rm -rf \
    "${REPO_ROOT}/node_modules" \
    "${REPO_ROOT}/packages"/*/node_modules \
    "${REPO_ROOT}/packages"/server/*/node_modules \
    "${REPO_ROOT}/package-lock.json"
}

# 1. Ensure the dev VM is running. dev-override.sh just bails if it isn't,
#    which is hostile on a clean clone — bring it up automatically.
vm_status="$(limactl list --format '{{.Status}}' "$NAME" 2>/dev/null || true)"
if [ "$vm_status" != "Running" ]; then
  echo "==> VM $NAME is not running — starting it (this can take a few minutes the first time)"
  "$VM_SH" up
fi

# 2. Bootstrap host workspace deps.
#
#    Done AFTER vm:up because on first boot the VM provisioning runs
#    `npm ci` / `npm install` on Linux against the 9p-mounted repo
#    (packages/server/setup/install.sh + dev-provision.sh), which rewrites
#    the host's node_modules — replacing @rolldown/binding-darwin-* with
#    Linux bindings on macOS. The self-heal below has to run after that
#    or vite crashes on startup with "Cannot find native binding".
#
#    Also handles https://github.com/npm/cli/issues/4828 — a package-lock.json
#    written on a different OS (e.g. Linux CI) locks in Linux-specific
#    @rolldown/binding-* optional deps, so npm installs them on macOS too.
#    Fix: after any install, verify the platform binding is present; if not,
#    nuke ALL workspace node_modules AND package-lock.json and reinstall so npm
#    re-resolves optional deps for the current platform from scratch.
if [ ! -x "${REPO_ROOT}/node_modules/.bin/vite" ]; then
  echo "==> Installing workspace dependencies"
  (cd "$REPO_ROOT" && npm install --include=optional --no-audit --no-fund)
fi

# Always verify rolldown binding (catches VM-provisioning corruption,
# stale-lockfile, and partial-install cases).
if ! rolldown_binding_ok; then
  echo "==> rolldown native binding missing for $(uname -s)/$(uname -m) — reinstalling…"
  full_clean
  (cd "$REPO_ROOT" && npm install --include=optional --no-audit --no-fund)
fi

# 3. Kill any stale process holding port 5173 from a previous run.
if lsof -ti :5173 >/dev/null 2>&1; then
  echo "==> Port 5173 in use — killing stale process…"
  lsof -ti :5173 | xargs kill -9 2>/dev/null || true
fi

# Run vite in the background so its stdout interleaves with journalctl.
(
  cd "$REPO_ROOT"
  exec npm -w app run dev
) &
VITE_PID=$!

cleanup() {
  # Send SIGTERM to the vite process group so npm + node + esbuild all
  # die. -$PGID targets every process whose pgid == VITE_PID (possible
  # because of `set -m` above).
  if kill -0 "$VITE_PID" 2>/dev/null; then
    kill -TERM -- "-$VITE_PID" 2>/dev/null || kill -TERM "$VITE_PID" 2>/dev/null || true
    # Give them a moment, then force-kill any stragglers.
    sleep 1
    kill -KILL -- "-$VITE_PID" 2>/dev/null || true
  fi
  # Belt-and-braces: kill anything left from this repo's prototype vite or port 5173.
  pkill -f "packages/app-prototype/node_modules/.*/vite" 2>/dev/null || true
  lsof -ti :5173 | xargs kill -9 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Vite dev server starting (pid $VITE_PID) on http://localhost:5173/"
echo "==> Streaming desk-server logs from the VM. Ctrl+C stops both."

# dev-override.sh installs its own trap that reverts the systemd override
# when it exits. Run in the foreground (not exec) so our EXIT trap above
# still fires and kills vite when dev-override.sh returns.
"${SCRIPT_DIR}/dev-override.sh"
