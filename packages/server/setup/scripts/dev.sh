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
