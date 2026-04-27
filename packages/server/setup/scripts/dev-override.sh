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

# Reading instance status doesn't need any privilege wrapper — only `up`
# and `reset` (which spawn QEMU) might, and that's handled inside vm.sh.
# Calling limactl directly here keeps this dev-only helper portable across
# macOS and Linux.
status="$(limactl list --format '{{.Status}}' "$NAME" 2>/dev/null || true)"
if [ "$status" != "Running" ]; then
  echo "Error: VM $NAME is not running. Run npm run vm:up first." >&2
  exit 1
fi

# Checked-in template. Both this helper and dev-override.test.ts consume it,
# so the override definition has a single source of truth.
OVERRIDE_SRC="${REPO_ROOT}/packages/server/setup/dev-override.conf"

cleanup() {
  echo ""
  echo "==> Reverting dev override..."
  vm "sudo rm -f /etc/systemd/system/desk-server.service.d/override.conf && sudo systemctl daemon-reload && sudo systemctl restart desk-server" || true
  echo "==> Prod service restored."
}

trap cleanup EXIT INT TERM

# /desk is the VM-side mount of $REPO_ROOT (see lima.yaml).
VM_OVERRIDE_SRC="/desk/packages/server/setup/dev-override.conf"

echo "==> Applying dev override on $NAME..."
vm "sudo mkdir -p /etc/systemd/system/desk-server.service.d && sudo install -m 644 $VM_OVERRIDE_SRC /etc/systemd/system/desk-server.service.d/override.conf && sudo systemctl daemon-reload && sudo systemctl restart desk-server"

echo "==> Dev override active. Streaming logs (Ctrl+C to revert)..."
# `sudo` because the default lima user typically isn't in `systemd-journal`,
# and journalctl without it just prints "No journal files were opened" and
# exits — which would tear down the whole dev stack on first start.
vm "sudo journalctl -fu desk-server"
