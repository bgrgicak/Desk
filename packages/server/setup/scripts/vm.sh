#!/usr/bin/env bash
# Thin wrapper around limactl that adds Desk's per-instance naming and
# deterministic host-port mapping.
set -euo pipefail

INSTANCE="${DESK_INSTANCE:-dev}"
NAME="desk-${INSTANCE}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CONFIG="${REPO_ROOT}/lima.yaml"

# Deterministic host port: 3000 + CRC32(instance) % 100, so an instance
# name always maps to the same host port across restarts.
PORT="$(python3 -c 'import zlib,sys; print(3000 + zlib.crc32(sys.argv[1].encode()) % 100)' "$INSTANCE")"

# Only `up` and `reset` actually spawn QEMU and need /dev/kvm access; the
# rest talk to the running VM via sockets in ~/.lima. If /dev/kvm isn't
# readable in the current shell (you haven't logged out since joining the
# `kvm` group), wrap QEMU-spawning calls in `sg kvm -c`.
if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  with_kvm() { "$@"; }
else
  with_kvm() { sg kvm -c "$(printf '%q ' "$@")"; }
fi

usage() {
  cat <<EOF
Usage: DESK_INSTANCE=<name> vm.sh <command>
Commands: up | halt | destroy | reload | provision | ssh | status |
          snapshot | restore | reset | exec <cmd...>
EOF
}

cmd="${1:-}"
shift || true

SET_EXPR=".mounts[0].location = \"$REPO_ROOT\" | .portForwards[0].hostPort = $PORT"

# "" if the instance doesn't exist, else "Running" | "Stopped" | etc.
vm_status() { limactl list --format '{{.Status}}' "$NAME" 2>/dev/null; }

case "$cmd" in
  up)
    if limactl list --quiet | grep -qx "$NAME"; then
      with_kvm limactl start "$NAME"
    else
      with_kvm limactl start --name="$NAME" --set="$SET_EXPR" --tty=false "$CONFIG"
    fi
    ;;
  halt)
    [ "$(vm_status)" = "Running" ] && limactl stop "$NAME" || echo "$NAME already stopped"
    ;;
  destroy)
    [ -n "$(vm_status)" ] && limactl delete --force "$NAME" || echo "$NAME doesn't exist"
    ;;
  reload)
    [ "$(vm_status)" = "Running" ] && limactl stop "$NAME"
    with_kvm limactl start "$NAME"
    ;;
  provision)  limactl shell "$NAME" sudo bash /desk/packages/server/setup/install.sh ;;
  ssh)        limactl shell "$NAME" ;;
  status)     limactl list "$NAME" ;;
  snapshot)   limactl snapshot create --tag clean-install "$NAME" ;;
  restore)    limactl snapshot apply --tag clean-install "$NAME" ;;
  reset)
    limactl delete --force "$NAME" || true
    with_kvm limactl start --name="$NAME" --set="$SET_EXPR" --tty=false "$CONFIG"
    ;;
  exec)
    # Wrap in `bash -c` inside the VM so shell operators (&&, |, redirects,
    # heredocs) are interpreted by the VM, not the host shell.
    limactl shell "$NAME" -- bash -c "$*"
    ;;
  *)
    usage; exit 1 ;;
esac
