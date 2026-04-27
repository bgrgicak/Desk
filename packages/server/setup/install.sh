#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# ---------- helpers ----------
log() { echo "==> $*"; }

# ---------- 1. baseline tools ----------
log "Installing baseline packages"
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates gnupg lsb-release build-essential at cron >/dev/null

# ---------- 2. Docker (official repo) ----------
if ! command -v docker &>/dev/null; then
  log "Installing Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io >/dev/null
fi
systemctl enable --now docker

# ---------- 3. Node LTS (NodeSource) ----------
if ! command -v node &>/dev/null; then
  log "Installing Node.js LTS"
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt-get install -y -qq nodejs >/dev/null
fi

# ---------- 4. Postgres 16 ----------
if ! dpkg -l postgresql-16 &>/dev/null; then
  log "Installing PostgreSQL 16"
  apt-get install -y -qq postgresql-16 >/dev/null
fi
systemctl enable --now postgresql

# Scheduler daemons the app relies on (used by @desk/scheduler).
systemctl enable --now atd cron

# ---------- 5. desk system user ----------
if ! id desk &>/dev/null; then
  log "Creating desk user (UID 2000)"
  useradd --system --uid 2000 --create-home --home-dir /home/desk --shell /usr/sbin/nologin desk
fi
# desk needs docker group access to talk to dockerd (spawn/manage sandboxes).
usermod -aG docker desk

# ---------- 6. Postgres role + database ----------
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='desk'" | grep -q 1; then
  log "Creating Postgres role and database"
  sudo -u postgres createuser --createdb desk
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='desk'" | grep -q 1; then
  sudo -u postgres createdb -O desk desk
fi
sudo -u postgres psql -d desk -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"

# ---------- 7. Build & install the server ----------
# Monorepo layout: @desk/api depends on workspace siblings (@desk/shared,
# @desk/db, …) that only resolve at the repo root. Install + build at root,
# then rsync the whole workspace (sans dev-only artefacts) into /opt/desk-server
# so node's module resolution from packages/server/api finds its deps via the
# root node_modules that npm workspaces set up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

log "Installing workspace dependencies at $REPO_ROOT"
cd "$REPO_ROOT"
npm ci --no-audit --no-fund

log "Building server workspace packages"
# The VM only runs the server. The host-side `app` prototype is built by
# Vite when the dev server starts; building it here just adds latency and
# couples the VM provision to the prototype's typecheck health.
npx nx run-many -t build --exclude=app

log "Staging /opt/desk-server from the built workspace"
rm -rf /opt/desk-server
mkdir -p /opt/desk-server
# Ship: top-level package metadata, node_modules, and each server package's
# package.json + dist + bin (where applicable). Skip src/tests/docs/.env/etc.
cp "$REPO_ROOT/package.json" "$REPO_ROOT/package-lock.json" /opt/desk-server/
cp -a "$REPO_ROOT/node_modules" /opt/desk-server/
mkdir -p /opt/desk-server/packages/server
for pkg in shared db storage tools runtime scheduler sandbox-cli api; do
  SRC="$REPO_ROOT/packages/server/$pkg"
  DST="/opt/desk-server/packages/server/$pkg"
  mkdir -p "$DST"
  cp "$SRC/package.json" "$DST/"
  [ -d "$SRC/dist" ] && cp -a "$SRC/dist" "$DST/"
  [ -d "$SRC/bin" ] && cp -a "$SRC/bin" "$DST/"
  [ -d "$SRC/migrations" ] && cp -a "$SRC/migrations" "$DST/"
done
# Preserve the workspace symlinks that npm created under root node_modules/@desk/*.
# `cp -a` copied them; just sanity-check one.
test -L /opt/desk-server/node_modules/@desk/shared || {
  echo "ERROR: expected @desk/shared to be a symlink under /opt/desk-server/node_modules/@desk/" >&2
  exit 1
}
chown -R desk:desk /opt/desk-server

# ---------- 8. Environment file ----------
log "Writing /etc/desk-server/env"
mkdir -p /etc/desk-server
cat > /etc/desk-server/env <<'ENVFILE'
DATABASE_URL=postgresql:///desk?host=/var/run/postgresql
PORT=8080
NODE_ENV=production
# Seed credentials for the initial user. Change DESK_SEED_PASSWORD before first boot.
DESK_SEED_USERNAME=desk
DESK_SEED_PASSWORD=change-me-before-first-boot
DESK_RUN_BIN=/opt/desk-server/node_modules/.bin/desk-run
# Explicit on-disk root. Must match across API, scheduler, and sandbox bind
# mounts — a silent split between $HOME and a hardcoded fallback caused user
# uploads to land in a tree the sandbox couldn't see.
DESK_HOME=/home/desk
ENVFILE

# ---------- 8b. Internal shared secret ----------
# Scheduled at/cron jobs loop back to /internal/messages/fire with this
# token (see packages/server/api/src/auth/internal.ts). The API would
# regenerate a missing token on first call, but it runs as the `desk`
# user and can't write into root-owned /etc/desk-server — so we seed it
# here at install time with the right owner + mode.
log "Generating /etc/desk-server/internal-token"
if [[ ! -f /etc/desk-server/internal-token ]]; then
  ( umask 077 && openssl rand -hex 32 > /etc/desk-server/internal-token )
fi
chown desk:desk /etc/desk-server/internal-token
chmod 0600 /etc/desk-server/internal-token

# ---------- 9. Systemd unit ----------
log "Writing desk-server.service"
cat > /etc/systemd/system/desk-server.service <<'UNIT'
[Unit]
Description=Desk Server
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
EnvironmentFile=/etc/desk-server/env
WorkingDirectory=/opt/desk-server/packages/server/api
ExecStart=/usr/bin/node /opt/desk-server/packages/server/api/dist/main.js
Restart=always
User=desk

[Install]
WantedBy=multi-user.target
UNIT

# ---------- 10. Enable & start ----------
log "Starting desk-server"
systemctl daemon-reload
systemctl enable --now desk-server

# ---------- Verify required commands ----------
log "Verifying at, cron, and docker are available"
for cmd in at cron docker; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is not installed" >&2
    exit 1
  fi
done

# ---------- Health check ----------
log "Waiting for desk-server to respond"
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8080/ | grep -q "hello world"; then
    log "desk-server is healthy"
    # Stamp this script's hash so vm.sh / deploy tooling can detect drift.
    sha256sum "${BASH_SOURCE[0]}" | awk '{print $1}' > /etc/desk-server/provision-hash
    exit 0
  fi
  sleep 1
done

echo "ERROR: desk-server did not respond with 'hello world' within 30s" >&2
exit 1
