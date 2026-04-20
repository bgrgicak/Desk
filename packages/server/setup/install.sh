#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# ---------- helpers ----------
log() { echo "==> $*"; }

# ---------- 1. baseline tools ----------
log "Installing baseline packages"
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates gnupg lsb-release build-essential >/dev/null

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

# ---------- 5. desk system user ----------
if ! id desk &>/dev/null; then
  log "Creating desk user (UID 2000)"
  useradd --system --uid 2000 --create-home --shell /usr/sbin/nologin desk
fi

# ---------- 6. Postgres role + database ----------
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='desk'" | grep -q 1; then
  log "Creating Postgres role and database"
  sudo -u postgres createuser desk
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='desk'" | grep -q 1; then
  sudo -u postgres createdb -O desk desk
fi

# ---------- 7. Build & install the server ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_DIR="$REPO_ROOT/packages/server/api"

log "Building server from $API_DIR"
cd "$API_DIR"
npm ci
npm run build

log "Installing server to /opt/desk-server"
mkdir -p /opt/desk-server
cp -a "$API_DIR/dist" /opt/desk-server/
cp "$API_DIR/package.json" /opt/desk-server/
cp "$API_DIR/package-lock.json" /opt/desk-server/ 2>/dev/null || true
cd /opt/desk-server
npm ci --omit=dev 2>/dev/null || true
chown -R desk:desk /opt/desk-server

# ---------- 8. Environment file ----------
log "Writing /etc/desk-server/env"
mkdir -p /etc/desk-server
cat > /etc/desk-server/env <<'ENVFILE'
DATABASE_URL=postgresql:///desk?host=/var/run/postgresql
PORT=8080
NODE_ENV=production
ENVFILE

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
WorkingDirectory=/opt/desk-server
ExecStart=/usr/bin/node /opt/desk-server/dist/index.js
Restart=always
User=desk

[Install]
WantedBy=multi-user.target
UNIT

# ---------- 10. Enable & start ----------
log "Starting desk-server"
systemctl daemon-reload
systemctl enable --now desk-server

# ---------- Health check ----------
log "Waiting for desk-server to respond"
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8080/ | grep -q "hello world"; then
    log "desk-server is healthy"
    exit 0
  fi
  sleep 1
done

echo "ERROR: desk-server did not respond with 'hello world' within 30s" >&2
exit 1
