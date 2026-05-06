#!/bin/sh
# Entrypoint for the desk/sandbox container.
#
# The workspace is bind-mounted at /home/agent. We seed it with shell
# dotfiles from /etc/skel on first start; cp -rn (no-clobber) is
# idempotent, so the agent's / user's edits to existing dotfiles persist
# across container restarts and image upgrades.
#
# Runs as whatever user the container was started as. The container's
# HostConfig drops ALL Linux capabilities, so uid-switching (gosu, su,
# setpriv) isn't available; we rely on Docker's uid remapping so the
# single container user can read/write the bind-mounted $HOME directly.
cp -rn /etc/skel/. "${HOME:-/home/agent}/" 2>/dev/null || true

export DISPLAY="${DISPLAY:-:99}"
Xvfb "$DISPLAY" -screen 0 "${XVFB_SCREEN:-1920x1080x24}" -nolisten tcp >/tmp/desk-xvfb.log 2>&1 &
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
  sleep 0.1
done

exec "$@"
