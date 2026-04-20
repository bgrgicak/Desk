#!/usr/bin/env bash
# Swaps desk-server's systemd unit to `tsx watch` against the mounted source
# and streams logs. Reverts on exit.
set -euo pipefail

INSTANCE="${DESK_INSTANCE:-dev}"
NAME="desk-${INSTANCE}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VM_SH="${SCRIPT_DIR}/vm.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

vm() { "$VM_SH" exec "$@"; }

if ! sg kvm -c "limactl list --quiet" | grep -qx "$NAME"; then
  echo "Error: VM $NAME is not running. Run npm run vm:up first." >&2
  exit 1
fi

# Stage the override.conf on the host side (it'll appear in the VM at
# /vagrant/...), then copy it into /etc via a single-line sudo command.
OVERRIDE_STAGE="${REPO_ROOT}/packages/server/setup/.dev-override.conf"
cat > "$OVERRIDE_STAGE" <<'OVERRIDE'
[Service]
ExecStart=
ExecStart=/usr/bin/npx tsx watch /vagrant/packages/server/api/src/index.ts
WorkingDirectory=/vagrant/packages/server/api
Environment=NODE_ENV=development
# 9p mount doesn't propagate inotify events; force chokidar to poll.
Environment=CHOKIDAR_USEPOLLING=1
Environment=CHOKIDAR_INTERVAL=500
Restart=no
OVERRIDE

cleanup() {
  echo ""
  echo "==> Reverting dev override..."
  vm "sudo rm -f /etc/systemd/system/desk-server.service.d/override.conf && sudo systemctl daemon-reload && sudo systemctl restart desk-server" || true
  rm -f "$OVERRIDE_STAGE"
  echo "==> Prod service restored."
}

trap cleanup EXIT INT TERM

echo "==> Applying dev override on $NAME..."
vm "sudo mkdir -p /etc/systemd/system/desk-server.service.d && sudo install -m 644 /vagrant/packages/server/setup/.dev-override.conf /etc/systemd/system/desk-server.service.d/override.conf && sudo systemctl daemon-reload && sudo systemctl restart desk-server"

echo "==> Dev override active. Streaming logs (Ctrl+C to revert)..."
vm "journalctl -fu desk-server"
