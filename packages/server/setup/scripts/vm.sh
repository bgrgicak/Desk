#!/usr/bin/env bash
# Thin wrapper around limactl that adds Desk's per-instance naming and
# deterministic host-port mapping.
set -euo pipefail

INSTANCE="${DESK_INSTANCE:-dev}"
NAME="desk-${INSTANCE}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CONFIG="${REPO_ROOT}/lima.yaml"

# Host-side path that gets mounted into the VM at /home/desk/Desk. The
# default `dev` instance keeps the friendly stable `~/Desk` so a backup
# tool can target one well-known directory. Other instances (typically
# throwaway test VMs from RUN_VM_TESTS=1 suites) get suffixed paths so
# they can't collide with the user's real data.
if [ "$INSTANCE" = "dev" ]; then
  DESK_HOME_HOST="$HOME/Desk"
else
  DESK_HOME_HOST="$HOME/Desk-${INSTANCE}"
fi

# Deterministic host port: 3000 + CRC32(instance) % 100, so an instance
# name always maps to the same host port across restarts.
PORT="$(python3 -c 'import zlib,sys; print(3000 + zlib.crc32(sys.argv[1].encode()) % 100)' "$INSTANCE")"

# Only `up` and `reset` actually spawn QEMU and need /dev/kvm access; the
# rest talk to the running VM via sockets in ~/.lima. On Linux, if /dev/kvm
# exists but the current shell isn't in the `kvm` group yet (no re-login
# since `usermod -aG kvm`), wrap QEMU-spawning calls in `sg kvm -c`.
# macOS uses Apple's Virtualization framework (or QEMU userspace) — no
# /dev/kvm, no `sg`, so just run commands directly.
if [ -e /dev/kvm ] && { [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; }; then
  with_kvm() { sg kvm -c "$(printf '%q ' "$@")"; }
else
  with_kvm() { "$@"; }
fi

if ! command -v limactl >/dev/null 2>&1; then
  echo "Error: limactl not found on PATH." >&2
  case "$(uname -s)" in
    Darwin) echo "Install with: brew install lima" >&2 ;;
    Linux)  echo "See https://lima-vm.io/docs/installation/" >&2 ;;
  esac
  exit 1
fi

usage() {
  cat <<EOF
Usage: DESK_INSTANCE=<name> vm.sh <command>
Commands: up | halt | destroy | reload | provision | ssh | ssh-desk |
          status | snapshot | restore | reset | exec <cmd...>
EOF
}

cmd="${1:-}"
shift || true

SET_EXPR=".mounts[0].location = \"$REPO_ROOT\" | .mounts[1].location = \"$DESK_HOME_HOST\" | .portForwards[0].hostPort = $PORT"

# "" if the instance doesn't exist, else "Running" | "Stopped" | etc.
vm_status() { limactl list --format '{{.Status}}' "$NAME" 2>/dev/null; }

INSTALL_SH="${REPO_ROOT}/packages/server/setup/install.sh"

# SHA-256 of install.sh, portable across macOS (shasum) and Linux (sha256sum).
install_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$INSTALL_SH" | awk '{print $1}'
  else
    shasum -a 256 "$INSTALL_SH" | awk '{print $1}'
  fi
}

# Returns 0 (true) when the VM's recorded hash differs from the current file.
needs_provision() {
  local current stored
  current="$(install_hash)"
  stored="$(limactl shell "$NAME" -- cat /etc/desk-server/provision-hash 2>/dev/null || true)"
  [ "$current" != "$stored" ]
}

run_provision() { limactl shell "$NAME" sudo bash /desk/packages/server/setup/install.sh; }

# Lima won't create a missing host mount path — make sure the directory
# exists before `limactl start` mounts it. install.sh inside the VM
# pre-creates and chowns the layout subdirs (lima.yaml configures the
# mount with securityModel: mapped-xattr, so guest-side chown is
# honored).
prep_desk_home() {
  mkdir -p "$DESK_HOME_HOST"
}

case "$cmd" in
  up)
    # Ensure the host-side Desk dir tree exists with the right perms
    # before Lima tries to mount it. See prep_desk_home for the full
    # rationale.
    prep_desk_home
    if limactl list --quiet | grep -qx "$NAME"; then
      with_kvm limactl start "$NAME"
    else
      with_kvm limactl start --name="$NAME" --set="$SET_EXPR" --tty=false "$CONFIG"
    fi
    if needs_provision; then
      echo "==> install.sh changed since last provision — reprovisioning $NAME..."
      run_provision
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
  provision)  run_provision ;;
  ssh)        limactl shell "$NAME" ;;
  ssh-desk)   limactl shell "$NAME" -- sudo -u desk bash ;;
  status)     limactl list "$NAME" ;;
  snapshot)   limactl snapshot create --tag clean-install "$NAME" ;;
  restore)    limactl snapshot apply --tag clean-install "$NAME" ;;
  reset)
    # Note: this destroys VM state but leaves $DESK_HOME_HOST on the host
    # untouched — that's the whole point of the host mount.
    prep_desk_home
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
