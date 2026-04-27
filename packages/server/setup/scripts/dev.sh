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

# 1. Bootstrap workspace deps. A clean clone won't have node_modules, and
#    `npm -w app run dev` needs vite installed before it can start.
#    Also handle https://github.com/npm/cli/issues/4828 — npm sometimes
#    leaves platform-specific optional deps (e.g. @rolldown/binding-*)
#    out of node_modules, and vite then crashes at startup. The fix is a
#    clean reinstall, which is what `vite --version` will surface.
needs_install=0
if [ ! -x "${REPO_ROOT}/node_modules/.bin/vite" ]; then
  needs_install=1
elif ! node -e "require('${REPO_ROOT}/node_modules/rolldown')" 2>/dev/null; then
  # rolldown installed but native binding missing — npm optional-deps bug #4828.
  # Must remove package-lock.json too, otherwise npm re-reads the broken resolution.
  echo "==> rolldown native binding missing — likely npm optional-deps bug. Reinstalling…"
  rm -rf "${REPO_ROOT}/node_modules" "${REPO_ROOT}/package-lock.json"
  needs_install=1
fi
if [ "$needs_install" = 1 ]; then
  echo "==> Installing workspace dependencies"
  (cd "$REPO_ROOT" && npm install --no-audit --no-fund)
fi

# 2. Ensure the dev VM is running. dev-override.sh just bails if it isn't,
#    which is hostile on a clean clone — bring it up automatically.
vm_status="$(limactl list --format '{{.Status}}' "$NAME" 2>/dev/null || true)"
if [ "$vm_status" != "Running" ]; then
  echo "==> VM $NAME is not running — starting it (this can take a few minutes the first time)"
  "$VM_SH" up
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
  # Belt-and-braces: kill anything left from this repo's prototype vite.
  pkill -f "packages/app-prototype/node_modules/.*/vite" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Vite dev server starting (pid $VITE_PID) on http://localhost:5173/"
echo "==> Streaming desk-server logs from the VM. Ctrl+C stops both."

# dev-override.sh installs its own trap that reverts the systemd override
# when it exits. Run in the foreground (not exec) so our EXIT trap above
# still fires and kills vite when dev-override.sh returns.
"${SCRIPT_DIR}/dev-override.sh"
