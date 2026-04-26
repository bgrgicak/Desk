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

exec "$@"
