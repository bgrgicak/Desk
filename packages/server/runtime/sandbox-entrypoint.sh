#!/bin/sh
# Entrypoint for the desk/sandbox container.
#
# The workspace is bind-mounted at /home/agent. We seed it with shell
# dotfiles from /etc/skel on first start; cp -rn (no-clobber) is
# idempotent, so the agent's / user's edits to existing dotfiles persist
# across container restarts and image upgrades.
#
# The container starts as root. On rootful Docker, agent execs run as the host
# uid:gid so bind-mounted workspace writes keep host ownership; on rootless
# Docker they run as 0:0 because the bind already maps to namespace root.
if [ "$(id -u)" = "0" ] && [ -n "${DESK_SANDBOX_AGENT_USER:-}" ] && [ "${DESK_SANDBOX_AGENT_USER:-}" != "0:0" ]; then
  agent_uid=${DESK_SANDBOX_AGENT_USER%%:*}
  agent_gid=${DESK_SANDBOX_AGENT_USER#*:}

  if ! getent group "$agent_gid" >/dev/null 2>&1; then
    groupmod -g "$agent_gid" agent 2>/dev/null || true
  fi
  agent_group=$(getent group "$agent_gid" | cut -d: -f1)
  [ -n "$agent_group" ] || agent_group=agent

  usermod -u "$agent_uid" -g "$agent_group" agent 2>/dev/null || true
  runtime_user=$(getent passwd "$agent_uid" | cut -d: -f1)
  [ -n "$runtime_user" ] || runtime_user=agent
  mkdir -p /etc/sudoers.d
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$runtime_user" >/etc/sudoers.d/agent
  chmod 0440 /etc/sudoers.d/agent
fi

if [ "$(id -u)" = "0" ] && [ "${DESK_SANDBOX_AGENT_USER:-}" != "0:0" ]; then
  runuser -u "${runtime_user:-agent}" -- cp -rn /etc/skel/. "${HOME:-/home/agent}/" 2>/dev/null || true
else
  cp -rn /etc/skel/. "${HOME:-/home/agent}/" 2>/dev/null || true
fi

link_skills='skills_target=$1; skills_link=$2; mkdir -p "$(dirname "$skills_link")"; if [ -L "$skills_link" ]; then ln -sfn "$skills_target" "$skills_link"; elif [ ! -e "$skills_link" ]; then ln -s "$skills_target" "$skills_link"; elif [ -d "$skills_link" ] && rmdir "$skills_link" 2>/dev/null; then ln -s "$skills_target" "$skills_link"; fi'
if [ "$(id -u)" = "0" ] && [ "${DESK_SANDBOX_AGENT_USER:-}" != "0:0" ]; then
  runuser -u "${runtime_user:-agent}" -- sh -c "$link_skills" sh /opt/desk-skills "${HOME:-/home/agent}/.config/opencode/skills" || true
  # Mirror Desk-shipped global apps into every workspace at $HOME/.apps so
  # the agent can `ls ~/.apps/` to browse them. Discovery still goes through
  # `desk-agent find library` — the symlink is just an ergonomic affordance.
  runuser -u "${runtime_user:-agent}" -- sh -c "$link_skills" sh /opt/desk-apps "${HOME:-/home/agent}/.apps" || true
else
  sh -c "$link_skills" sh /opt/desk-skills "${HOME:-/home/agent}/.config/opencode/skills" || true
  sh -c "$link_skills" sh /opt/desk-apps "${HOME:-/home/agent}/.apps" || true
fi

if [ -f "${HOME:-/home/agent}/.deskrc" ]; then
  if [ "$(id -u)" = "0" ] && [ "${DESK_SANDBOX_AGENT_USER:-}" != "0:0" ]; then
    runuser -u "${runtime_user:-agent}" -- /bin/bash "${HOME:-/home/agent}/.deskrc" || echo "[deskrc] non-zero exit; continuing"
  else
    /bin/bash "${HOME:-/home/agent}/.deskrc" || echo "[deskrc] non-zero exit; continuing"
  fi
fi

# Pin DESK_HOME to the workspace root so that any desk-server started inside
# the sandbox stores data at the workspace level (e.g. /home/agent/.database)
# rather than creating a "Desk" subdirectory inside the project files.
export DESK_HOME="${HOME:-/home/agent}"

# Xvfb is needed only when playwright-mcp is enabled (site/app-goal
# chats). It costs ~68 MB resident at idle, which is a lot for the
# majority of chats that never touch a browser. Don't auto-start it
# here — the host runtime calls `ensureContainerXvfb` from
# `opencodeServer.ts` when the workspace MCP config flips
# playwright on, and that helper does an idempotent same-script start.
# `$DISPLAY` is still exported so any process that DOES need it
# inherits the right value once Xvfb is running.
export DISPLAY="${DISPLAY:-:99}"
touch /tmp/desk-entrypoint-ready

exec "$@"
