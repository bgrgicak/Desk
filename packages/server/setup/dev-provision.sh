#!/usr/bin/env bash
# Dev-only provisioning. Runs AFTER install.sh inside the Lima VM.
# Sets up the environment needed to run the test suite against real backends:
#   - sandbox-cli built and desk/sandbox:v1 image built for the runtime tests
#   - docker group on the `desk` user so the test runner can reach dockerd
#
# Safe to re-run. Not intended for production hosts — production doesn't
# need the sandbox image installed via this path.
#
# Note: the database (SQLite) is a single file at $DESK_HOME/Desk/desk.db,
# created on first server boot — no role/auth/extension setup needed here.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

log() { echo "==> [dev-provision] $*"; }

# ---------- 0. Swap file ----------
# The VM ships without swap, so memory pressure becomes an instant OOM.
# Give systemd cgroups (and runaway builds) a safety net.
SWAPFILE="/swapfile"
SWAP_SIZE_MB=4096
if ! sudo swapon --show=NAME --noheadings | grep -qx "$SWAPFILE"; then
  if [ ! -f "$SWAPFILE" ]; then
    log "Creating ${SWAP_SIZE_MB}MiB swapfile at $SWAPFILE"
    sudo fallocate -l "${SWAP_SIZE_MB}M" "$SWAPFILE" \
      || sudo dd if=/dev/zero of="$SWAPFILE" bs=1M count="$SWAP_SIZE_MB" status=none
    sudo chmod 600 "$SWAPFILE"
    sudo mkswap "$SWAPFILE" >/dev/null
  fi
  log "Enabling swap"
  sudo swapon "$SWAPFILE"
fi
if ! grep -qE "^${SWAPFILE}\s" /etc/fstab; then
  log "Persisting swap in /etc/fstab"
  echo "${SWAPFILE} none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
fi

# ---------- 1. Docker group for the login user ----------
# Lima's default user is `desk`. Give it docker access so test runs don't
# need root/sudo to talk to dockerd.
if id desk &>/dev/null; then
  log "Adding desk to the docker group"
  sudo usermod -aG docker desk
fi

# ---------- 3. Monorepo install + builds ----------
# Root npm install wires up workspaces (@desk/shared, @desk/db, etc.) so tests
# can resolve cross-package imports.
log "Running root npm install for workspaces"
cd "$REPO_ROOT"
# Ensure the bind-mount (if already set up) is temporarily detached so
# `npm install` writes to the real 9p-backed tree, not the VM-local shadow.
# The mount is re-established further down after we resync.
if mountpoint -q "$REPO_ROOT/node_modules" 2>/dev/null; then
  sudo umount "$REPO_ROOT/node_modules"
fi
npm install --no-audit --no-fund --silent

# ---------- VM-local node_modules (shadow to avoid 9p churn) ----------
# Host-side `npm install` rewrites /desk/node_modules via the 9p mount.
# tsx watch inside the VM reacts to those unlinks by rebuilding into a
# broken state. Materialize a VM-local copy and bind-mount it over the 9p
# tree so the running server sees a stable snapshot regardless of host
# churn. Re-run dev-provision to refresh the snapshot.
VM_NM="/home/desk/vm-node_modules"
REPO_NM="$REPO_ROOT/node_modules"
if [ -d "$REPO_NM" ]; then
  log "Syncing $REPO_NM → $VM_NM (VM-local shadow)"
  sudo mkdir -p "$VM_NM"
  sudo rsync -a --delete "$REPO_NM/" "$VM_NM/"
  sudo chown -R desk:desk "$VM_NM"

  # Install the systemd mount unit on first run.
  sudo install -m 644 \
    "$REPO_ROOT/packages/server/setup/systemd/desk-node_modules.mount" \
    /etc/systemd/system/desk-node_modules.mount
  sudo systemctl daemon-reload
  sudo systemctl enable desk-node_modules.mount >/dev/null
  sudo systemctl start desk-node_modules.mount

  # Bounce desk-server so it picks up the shadowed tree.
  sudo systemctl restart desk-server || true
fi

log "Building @desk/sandbox-cli"
cd "$REPO_ROOT/packages/server/sandbox-cli"
npm run build --silent

log "Building all workspace packages (nx)"
cd "$REPO_ROOT"
npm run build --silent || true

log "Building desk/sandbox:v1 image (AGENT_UID=2000 to match the VM desk user)"
cd "$REPO_ROOT/packages/server"
sg docker -c "docker build --build-arg AGENT_UID=2000 -f runtime/Dockerfile.sandbox -t desk/sandbox:v1 ." 2>&1 | tail -5

log "Installing Playwright Chromium in the VM"
cd "$REPO_ROOT" && npx playwright install --with-deps chromium

log "dev-provision complete"
