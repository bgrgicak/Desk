#!/usr/bin/env bash
# Dev-only provisioning. Runs AFTER install.sh inside the Lima VM.
# Sets up the environment needed to run the test suite against real backends:
#   - test password on the `desk` Postgres role (so tests can authenticate over TCP/md5)
#   - md5 auth enabled for local connections (peer auth still used by postgres superuser)
#   - sandbox-cli built and desk/sandbox:v1 image built for the runtime tests
#   - docker group on the `bero` user so the test runner can reach dockerd
#
# Safe to re-run. Not intended for production hosts — production relies on
# peer auth and does not need the sandbox image installed via this path.
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

# ---------- 1. Dev-friendly Postgres auth ----------
# Give the `desk` role a known password so tests running as non-desk OS users
# can connect over TCP via md5.
log "Setting dev password on desk Postgres role"
sudo -u postgres psql -c "ALTER ROLE desk WITH PASSWORD 'desk';" >/dev/null

# Preserve peer auth for the production path (desk-server runs as the desk
# OS user and connects to the desk DB role via unix socket → peer auth must
# still work), but ALSO allow md5 so tests running as bero (or any other OS
# user) can authenticate as the desk role using the dev password.
# Rule order matters: specific peer rules come FIRST.
PG_HBA="/etc/postgresql/16/main/pg_hba.conf"
log "Rewriting $PG_HBA: peer for postgres+desk, md5 for everyone else"
sudo tee "$PG_HBA" >/dev/null <<'HBA'
# Managed by packages/server/setup/dev-provision.sh.
# Keep the specific peer rules above the catch-all md5 rule.
local   all             postgres                                peer
local   desk            desk                                    peer
local   all             all                                     md5
host    all             all             127.0.0.1/32            md5
host    all             all             ::1/128                 md5
local   replication     all                                     peer
host    replication     all             127.0.0.1/32            md5
host    replication     all             ::1/128                 md5
HBA
sudo systemctl reload postgresql

# ---------- 2. Docker group for the login user ----------
# Lima's default user is `bero`. Give it docker access so test runs don't
# need root/sudo to talk to dockerd.
if id bero &>/dev/null; then
  log "Adding bero to the docker group"
  sudo usermod -aG docker bero
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
