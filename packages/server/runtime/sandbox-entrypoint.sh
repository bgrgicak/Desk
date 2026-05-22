#!/bin/sh
# Entrypoint for the roomy/sandbox container.
#
# The workspace is bind-mounted at /home/agent. We seed it with shell
# dotfiles from /etc/skel on first start; cp -rn (no-clobber) is
# idempotent, so the agent's / user's edits to existing dotfiles persist
# across container restarts and image upgrades.
#
# The container starts as root. On rootful Docker, agent execs run as the host
# uid:gid so bind-mounted workspace writes keep host ownership; on rootless
# Docker they run as 0:0 because the bind already maps to namespace root.
if [ "$(id -u)" = "0" ] && [ -n "${ROOMY_SANDBOX_AGENT_USER:-}" ] && [ "${ROOMY_SANDBOX_AGENT_USER:-}" != "0:0" ]; then
  agent_uid=${ROOMY_SANDBOX_AGENT_USER%%:*}
  agent_gid=${ROOMY_SANDBOX_AGENT_USER#*:}

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

if [ "$(id -u)" = "0" ] && [ "${ROOMY_SANDBOX_AGENT_USER:-}" != "0:0" ]; then
  runuser -u "${runtime_user:-agent}" -- cp -rn /etc/skel/. "${HOME:-/home/agent}/" 2>/dev/null || true
else
  cp -rn /etc/skel/. "${HOME:-/home/agent}/" 2>/dev/null || true
fi

# Link the host-mounted skills bundle into pi's discovery path. Pi
# auto-discovers skills under ~/.agents/skills (per Agent Skills standard),
# walking from cwd up through parents; we symlink the read-only mount at
# /opt/roomy-skills into the home location so every pi invocation, from any
# cwd, sees the Roomy-bundled reference + goal skills.
link_skills='skills_target=$1; skills_link=$2; mkdir -p "$(dirname "$skills_link")"; if [ -L "$skills_link" ]; then ln -sfn "$skills_target" "$skills_link"; elif [ ! -e "$skills_link" ]; then ln -s "$skills_target" "$skills_link"; elif [ -d "$skills_link" ] && rmdir "$skills_link" 2>/dev/null; then ln -s "$skills_target" "$skills_link"; fi'
if [ "$(id -u)" = "0" ] && [ "${ROOMY_SANDBOX_AGENT_USER:-}" != "0:0" ]; then
  runuser -u "${runtime_user:-agent}" -- sh -c "$link_skills" sh /opt/roomy-skills "${HOME:-/home/agent}/.agents/skills" || true
  # Mirror Roomy-shipped global apps into every workspace at $HOME/.apps so
  # the agent can `ls ~/.apps/` to browse them. Discovery still goes through
  # `roomy-agent find library` — the symlink is just an ergonomic affordance.
  runuser -u "${runtime_user:-agent}" -- sh -c "$link_skills" sh /opt/roomy-apps "${HOME:-/home/agent}/.apps" || true
else
  sh -c "$link_skills" sh /opt/roomy-skills "${HOME:-/home/agent}/.agents/skills" || true
  sh -c "$link_skills" sh /opt/roomy-apps "${HOME:-/home/agent}/.apps" || true
fi

if [ -f "${HOME:-/home/agent}/.roomyrc" ]; then
  if [ "$(id -u)" = "0" ] && [ "${ROOMY_SANDBOX_AGENT_USER:-}" != "0:0" ]; then
    runuser -u "${runtime_user:-agent}" -- /bin/bash "${HOME:-/home/agent}/.roomyrc" || echo "[roomyrc] non-zero exit; continuing"
  else
    /bin/bash "${HOME:-/home/agent}/.roomyrc" || echo "[roomyrc] non-zero exit; continuing"
  fi
fi

# Pin ROOMY_HOME to the workspace root so that any roomy-server started inside
# the sandbox stores data at the workspace level (e.g. /home/agent/.database)
# rather than creating a "Roomy" subdirectory inside the project files.
export ROOMY_HOME="${HOME:-/home/agent}"

touch /tmp/roomy-entrypoint-ready

exec "$@"
