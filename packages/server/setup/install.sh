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

# ---------- 3. Node (NodeSource) ----------
# Pin to the major version named in `.nvmrc` — the project's single source
# of truth for Node. Same pin matters across both sides because the
# host-mounted /desk tree is shared, and `npm ci` overwrites
# better-sqlite3's `build/Release/better_sqlite3.node` with a binary
# compiled for whatever version of Node ran it last. Mismatched ABIs
# fail with NODE_MODULE_VERSION errors when the other side tries to
# load the file.
NODE_MAJOR="$(awk -F. 'NR==1{gsub(/^v/,"",$1); print $1}' /desk/.nvmrc)"
if [ -z "$NODE_MAJOR" ]; then
  echo "ERROR: could not read major version from /desk/.nvmrc" >&2
  exit 1
fi
if ! command -v node &>/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  log "Installing Node.js $NODE_MAJOR.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  # If a different major is already installed, plain `apt install nodejs`
  # silently no-ops because apt won't downgrade across the version-pinned
  # NodeSource repos. Remove first so the install always picks up the
  # candidate from the repo we just configured.
  if command -v node &>/dev/null; then
    apt-get remove -y -qq nodejs >/dev/null
  fi
  apt-get install -y -qq nodejs >/dev/null
fi

# ---------- 4. SQLite CLI (engine ships with better-sqlite3) ----------
# better-sqlite3 statically links its own SQLite, so the npm dependency is
# self-contained. The `sqlite3` CLI is here for ops access — backups
# (`sqlite3 desk.db .backup …`), ad-hoc queries, schema inspection — and
# adds nothing to the runtime cost.
if ! command -v sqlite3 &>/dev/null; then
  log "Installing sqlite3 CLI"
  apt-get install -y -qq sqlite3 >/dev/null
fi

# Scheduler daemons the app relies on (used by @desk/scheduler).
systemctl enable --now atd cron

# ---------- 5. Service user (always `desk`, UID 2000) ----------
# The systemd unit runs as `desk` regardless of how the VM was created.
# Anyone debugging "why is desk-server running as user X?" should never
# have to find the answer in this script.
if ! id desk &>/dev/null; then
  log "Creating desk user (UID 2000)"
  useradd --system --uid 2000 --create-home --home-dir /home/desk --shell /usr/sbin/nologin desk
fi
# /home/desk is local VM filesystem (not the mount itself — that's mounted
# at /home/desk/Desk). Lima creates this dir as a mount target during boot,
# before this script runs, so it lands as root:root and `useradd
# --create-home` above is a no-op on it. Chown to desk so the user actually
# owns its own home — without this, npm/npx can't create ~/.npm and the
# systemd unit crashes with EACCES on first `npx tsx ...`.
chown desk:desk /home/desk
chmod 755 /home/desk
# desk needs docker group access to talk to dockerd (spawn / manage
# sandboxes).
usermod -aG docker desk

# ---------- 6. Layout under /home/desk/Desk ----------
# Pre-create every top-level subdirectory the server might write to and
# hand ownership to `desk` so it doesn't need write access on the mount
# root itself (which can't be chown'd through the 9p mount on the host).
# With `securityModel: mapped-xattr` (set in lima.yaml), the guest's
# chown stores ownership in xattrs on the host — desk genuinely owns
# these dirs and can write/chmod its own files normally, including the
# WAL/journal files SQLite creates next to desk.sqlite3.
#
# After this step:
#   /home/desk/Desk             host-owned, mode 0755 (traverse only)
#   /home/desk/Desk/.database/  desk-owned, holds desk.sqlite3 + WAL
#   /home/desk/Desk/.tmp/       desk-owned, scratch space
#   /home/desk/Desk/.trash/     desk-owned, soft-deleted workspaces
#   /home/desk/Desk/workspaces/ desk-owned, parent of per-workspace dirs
#   /home/desk/Desk/backups/    desk-owned, /internal/backup destination
#
# Recursive chown: any of these dirs may already contain sub-trees from a
# previous host-side run (e.g. an older topology where the API server ran
# on the host as the host user). Files created that way come back into
# the VM owned by the host UID and the in-VM `desk` user can't write to
# them — uploads then fail with EACCES on rename into the workspace dir.
# Reclaiming ownership on every provision keeps the tree writable by
# desk-server regardless of who created the files.
for sub in .database .tmp .trash workspaces backups; do
  mkdir -p "/home/desk/Desk/$sub"
  chown -R desk:desk "/home/desk/Desk/$sub"
done

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

# Force rebuild of native addons against the VM's Node ABI. `npm ci` may
# accept a prebuilt binary that prebuild-install downloaded for a
# different Node major (or, when /desk is a 9p mount of the host's tree,
# inherit a binding compiled by a different host Node), then `cp -a` later
# stages that wrong-ABI binding into /opt/desk-server and desk-server
# crashloops with NODE_MODULE_VERSION mismatches. Building from source
# inside the VM guarantees the binding matches the Node we ship with.
log "Rebuilding native addons from source against VM Node $(node --version)"
npm rebuild --build-from-source better-sqlite3

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
for pkg in shared db storage runtime scheduler sandbox-cli api; do
  SRC="$REPO_ROOT/packages/server/$pkg"
  DST="/opt/desk-server/packages/server/$pkg"
  mkdir -p "$DST"
  cp "$SRC/package.json" "$DST/"
  [ -d "$SRC/dist" ] && cp -a "$SRC/dist" "$DST/"
  [ -d "$SRC/bin" ] && cp -a "$SRC/bin" "$DST/"
  [ -d "$SRC/migrations" ] && cp -a "$SRC/migrations" "$DST/"
  # @desk/runtime resolves sandbox skill markdown by walking back through
  # the workspace tree (../../sandbox-cli/skill.md). Source files aren't
  # otherwise needed in /opt/desk-server, so ship just the markdown the
  # runtime opens at boot.
  [ -f "$SRC/skill.md" ] && cp "$SRC/skill.md" "$DST/"
done
# Preserve the workspace symlinks that npm created under root node_modules/@desk/*.
# `cp -a` copied them; just sanity-check one.
test -L /opt/desk-server/node_modules/@desk/shared || {
  echo "ERROR: expected @desk/shared to be a symlink under /opt/desk-server/node_modules/@desk/" >&2
  exit 1
}
chown -R "desk:desk" /opt/desk-server

# ---------- 8. Environment file ----------
log "Writing /etc/desk-server/env"
mkdir -p /etc/desk-server
cat > /etc/desk-server/env <<'ENVFILE'
DESK_DB_PATH=/home/desk/Desk/.database/desk.sqlite3
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
chown "desk:desk" /etc/desk-server/internal-token
chmod 0600 /etc/desk-server/internal-token

# ---------- 9. Systemd unit ----------
log "Writing desk-server.service (User=desk)"
cat > /etc/systemd/system/desk-server.service <<UNIT
[Unit]
Description=Desk Server
After=network.target

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
