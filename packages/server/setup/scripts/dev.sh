#!/usr/bin/env bash
# Starts the full dev stack:
#   - app-prototype Vite dev server on the host (http://localhost:5173/)
#   - desk-server in tsx-watch mode inside the VM, streaming logs
#
# Ctrl+C shuts both down cleanly — vite gets SIGTERM, dev-override.sh
# reverts the systemd override on its own trap.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

# Run vite in the background so its stdout interleaves with journalctl.
(
  cd "$REPO_ROOT"
  npm -w app run dev
) &
VITE_PID=$!

cleanup() {
  # Best-effort: send SIGTERM to the vite process group so its children die too.
  if kill -0 "$VITE_PID" 2>/dev/null; then
    kill -- "-$VITE_PID" 2>/dev/null || kill "$VITE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "==> Vite dev server starting (pid $VITE_PID) on http://localhost:5173/"
echo "==> Streaming desk-server logs from the VM. Ctrl+C stops both."

# dev-override.sh installs its own trap that reverts the systemd override
# when it exits. Run in the foreground (not exec) so our EXIT trap above
# still fires and kills vite when dev-override.sh returns.
"${SCRIPT_DIR}/dev-override.sh"
