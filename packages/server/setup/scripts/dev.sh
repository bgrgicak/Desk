#!/usr/bin/env bash
# Starts the full dev stack:
#   - app-prototype Vite dev server on the host (http://localhost:5173/)
#   - desk-server in tsx-watch mode inside the VM, streaming logs
#
# Ctrl+C shuts both down cleanly — vite gets SIGTERM, dev-override.sh
# reverts the systemd override on its own trap.
set -uo pipefail

# Enable job control so the backgrounded subshell becomes its own
# process-group leader. Without this, kill -- -PGID can't reach the
# vite/node children and they survive Ctrl+C, binding ports 5174+
# on subsequent runs.
set -m

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
VM_SH="${SCRIPT_DIR}/vm.sh"
INSTANCE="${DESK_INSTANCE:-dev}"
NAME="desk-${INSTANCE}"

# Returns 0 if the rolldown native binding for the current OS/arch is present.
rolldown_binding_ok() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"
  find "${REPO_ROOT}/node_modules/@rolldown" -maxdepth 2 \
    -path "*binding-${os}-${arch}*" -name "*.node" 2>/dev/null | grep -q .
}

# Removes every workspace node_modules + package-lock.json so npm re-resolves
# optional deps for the current platform from scratch.
full_clean() {
  rm -rf \
    "${REPO_ROOT}/node_modules" \
    "${REPO_ROOT}/packages"/*/node_modules \
    "${REPO_ROOT}/packages"/server/*/node_modules \
    "${REPO_ROOT}/package-lock.json"
}

# 0. Pin host Node to the major version in .nvmrc.
#
#    The host and the VM share /desk/node_modules over 9p. Native modules
#    (better-sqlite3) carry a NODE_MODULE_VERSION compiled against
#    whichever Node ran `npm install` — so a host on a different major
#    than the VM produces an ABI mismatch the moment either side dlopens
#    the binding. install.sh pins the VM via the same .nvmrc; this is
#    the host counterpart. Hard fail rather than warn — a "wrong Node"
#    dev session corrupts the shared tree for the next run.
NVMRC_MAJOR="$(awk -F. 'NR==1{gsub(/^v/,"",$1); print $1}' "${REPO_ROOT}/.nvmrc" 2>/dev/null || true)"
HOST_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [ -n "$NVMRC_MAJOR" ] && [ "$HOST_MAJOR" != "$NVMRC_MAJOR" ]; then
  echo "ERROR: host Node is v${HOST_MAJOR:-?} but .nvmrc requires v${NVMRC_MAJOR}." >&2
  echo "       Run \`nvm install ${NVMRC_MAJOR} && nvm use\` (or your equivalent) and retry." >&2
  exit 1
fi

# 1. Ensure the dev VM is running. dev-override.sh just bails if it isn't,
#    which is hostile on a clean clone — bring it up automatically.
vm_status="$(limactl list --format '{{.Status}}' "$NAME" 2>/dev/null || true)"
if [ "$vm_status" != "Running" ]; then
  echo "==> VM $NAME is not running — starting it (this can take a few minutes the first time)"
  "$VM_SH" up
fi

# 2. Bootstrap host workspace deps.
#
#    Done AFTER vm:up because on first boot the VM provisioning runs
#    `npm ci` / `npm install` on Linux against the 9p-mounted repo
#    (packages/server/setup/install.sh + dev-provision.sh), which rewrites
#    the host's node_modules — replacing @rolldown/binding-darwin-* with
#    Linux bindings on macOS. The self-heal below has to run after that
#    or vite crashes on startup with "Cannot find native binding".
#
#    Also handles https://github.com/npm/cli/issues/4828 — a package-lock.json
#    written on a different OS (e.g. Linux CI) locks in Linux-specific
#    @rolldown/binding-* optional deps, so npm installs them on macOS too.
#    Fix: after any install, verify the platform binding is present; if not,
#    nuke ALL workspace node_modules AND package-lock.json and reinstall so npm
#    re-resolves optional deps for the current platform from scratch.
host_installed=0
if [ ! -x "${REPO_ROOT}/node_modules/.bin/vite" ]; then
  echo "==> Installing workspace dependencies"
  (cd "$REPO_ROOT" && npm install --include=optional --no-audit --no-fund)
  host_installed=1
fi

# Always verify rolldown binding (catches VM-provisioning corruption,
# stale-lockfile, and partial-install cases).
if ! rolldown_binding_ok; then
  echo "==> rolldown native binding missing for $(uname -s)/$(uname -m) — reinstalling…"
  full_clean
  (cd "$REPO_ROOT" && npm install --include=optional --no-audit --no-fund)
  host_installed=1
fi

# After any host npm install, refresh the VM-local node_modules shadow.
# dev-provision.sh bind-mounts /home/desk/vm-node_modules over
# /desk/node_modules so the VM is insulated from 9p churn — but that
# means newly-installed deps on the host are invisible to the in-VM
# server until we rsync them across. Reading the host tree requires
# stopping the bind first (otherwise /desk/node_modules shows the
# shadow). Skipped when no host install ran — rsync is fast on a
# no-op but `systemctl stop` would briefly tear the server's
# require() resolution out from under it.
if [ "$host_installed" = "1" ]; then
  echo "==> Re-syncing VM node_modules shadow"
  # Stop the bind mount so /desk/node_modules shows the host (macOS/Linux)
  # tree. rsync copies it verbatim to the VM-local shadow — including any
  # macOS Mach-O native binaries that are invalid ELF on Linux.
  # After remounting, rebuild better-sqlite3 from source inside the VM so
  # the shadow always has a Linux ELF binary regardless of host platform.
  "$VM_SH" exec "
    sudo systemctl stop desk-node_modules.mount &&
    sudo rsync -a --delete /desk/node_modules/ /home/desk/vm-node_modules/ &&
    sudo chown -R desk:desk /home/desk/vm-node_modules &&
    sudo systemctl start desk-node_modules.mount &&
    echo '==> Rebuilding better-sqlite3 for Linux inside VM' &&
    cd /desk && sudo npm rebuild --build-from-source better-sqlite3 &&
    sudo chown -R desk:desk /home/desk/vm-node_modules/better-sqlite3/build &&
    sudo systemctl restart desk-server || true
  "
fi

# 3. Ensure DESK_SECRET_KEY is persisted on the host and injected into the VM.
#
#    The DB encryption module (packages/server/db/src/encryption.ts) prefers
#    DESK_SECRET_KEY (base64 32 bytes) over its on-disk fallback at
#    /home/desk/secret.key. The fallback lives on the VM disk, which means
#    any state desync between the VM and the user_settings.provider_keys_encrypted
#    blob — a stray reprovision, snapshot restore, or hand-deleted file —
#    silently changes the key and breaks decryption. Pin the key to host
#    .env (gitignored) so it survives every VM operation.
ENV_FILE="${REPO_ROOT}/.env"
desk_secret_key=""
if [ -f "$ENV_FILE" ]; then
  desk_secret_key="$(grep -E '^DESK_SECRET_KEY=' "$ENV_FILE" 2>/dev/null | tail -n1 \
    | sed -E 's/^DESK_SECRET_KEY=//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/')"
fi
if [ -z "$desk_secret_key" ]; then
  # Migrate an existing VM-side key file so previously encrypted rows still
  # decrypt. Falls through to fresh generation if there's nothing to import.
  existing_b64="$("$VM_SH" exec 'sudo test -f /home/desk/secret.key && sudo base64 -w0 /home/desk/secret.key 2>/dev/null || true' 2>/dev/null | tr -d ' \r\n')"
  if [ -n "$existing_b64" ]; then
    echo "==> Importing existing /home/desk/secret.key into ${ENV_FILE}"
    desk_secret_key="$existing_b64"
  else
    echo "==> Generating DESK_SECRET_KEY (32 bytes, base64) → ${ENV_FILE}"
    desk_secret_key="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
  fi
  touch "$ENV_FILE"
  # `$(...)` strips trailing \n, so non-empty output ⇒ file doesn't end in newline.
  if [ -s "$ENV_FILE" ] && [ -n "$(tail -c1 "$ENV_FILE")" ]; then
    printf '\n' >> "$ENV_FILE"
  fi
  printf 'DESK_SECRET_KEY=%s\n' "$desk_secret_key" >> "$ENV_FILE"
fi
echo "==> Syncing DESK_SECRET_KEY into VM /etc/desk-server/env"
"$VM_SH" exec "sudo install -d /etc/desk-server && sudo touch /etc/desk-server/env && sudo sed -i '/^DESK_SECRET_KEY=/d' /etc/desk-server/env && echo 'DESK_SECRET_KEY=${desk_secret_key}' | sudo tee -a /etc/desk-server/env >/dev/null"

# 4. Kill any stale process holding port 5173 from a previous run.
if lsof -ti :5173 >/dev/null 2>&1; then
  echo "==> Port 5173 in use — killing stale process…"
  lsof -ti :5173 | xargs kill -9 2>/dev/null || true
fi

# Run vite in the background so its stdout interleaves with journalctl.
(
  cd "$REPO_ROOT"
  exec npm -w app run dev
) &
VITE_PID=$!

cleanup() {
  # Send SIGTERM to the vite process group so npm + node + esbuild all
  # die. -$PGID targets every process whose pgid == VITE_PID (possible
  # because of `set -m` above).
  if kill -0 "$VITE_PID" 2>/dev/null; then
    kill -TERM -- "-$VITE_PID" 2>/dev/null || kill -TERM "$VITE_PID" 2>/dev/null || true
    # Give them a moment, then force-kill any stragglers.
    sleep 1
    kill -KILL -- "-$VITE_PID" 2>/dev/null || true
  fi
  # Belt-and-braces: kill anything left from this repo's prototype vite or port 5173.
  pkill -f "packages/app-prototype/node_modules/.*/vite" 2>/dev/null || true
  lsof -ti :5173 | xargs kill -9 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Vite dev server starting (pid $VITE_PID) on http://localhost:5173/"
echo "==> Streaming desk-server logs from the VM. Ctrl+C stops both."

# dev-override.sh installs its own trap that reverts the systemd override
# when it exits. Run in the foreground (not exec) so our EXIT trap above
# still fires and kills vite when dev-override.sh returns.
"${SCRIPT_DIR}/dev-override.sh"
