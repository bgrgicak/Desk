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
npm install --no-audit --no-fund --silent

log "Building @desk/sandbox-cli"
cd "$REPO_ROOT/packages/server/sandbox-cli"
npm run build --silent

log "Building all workspace packages (nx)"
cd "$REPO_ROOT"
npm run build --silent || true

log "Building desk/sandbox:v1 image (AGENT_UID=1000 to match bero)"
cd "$REPO_ROOT/packages/server"
sg docker -c "docker build --build-arg AGENT_UID=1000 -f runtime/Dockerfile.sandbox -t desk/sandbox:v1 ." 2>&1 | tail -5

log "Installing Playwright Chromium in the VM"
cd "$REPO_ROOT" && npx playwright install --with-deps chromium

log "dev-provision complete"
