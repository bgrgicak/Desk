## Persistence (~/.roomyrc)

You have root access for setup work. On rootful Docker, normal agent commands
run as the workspace-owning user with passwordless `sudo`; on rootless Docker,
normal agent commands may already run as root. Anything you install or configure
outside `~/` is wiped on container restart unless it is recorded in `~/.roomyrc`.
The container replays `~/.roomyrc` on every start.

- Run setup commands in the current container when you need them now, and always
  record the idempotent form in `~/.roomyrc` immediately so the setup survives
  future starts.
- There are no ephemeral package installs. After any package-manager command
  that modifies the environment, including `apt-get install`, `pip install`,
  `npm install -g`, or similar, always add the idempotent install command to
  `~/.roomyrc` immediately; do not ask first, and do not treat persistence as
  optional follow-up work.
- Installing a package without persisting it in `~/.roomyrc` is an incomplete
  action.
- For Debian packages, use `sudo apt-get update && sudo apt-get install -y --no-install-recommends ...`.
- Every line must be idempotent (`apt-get install` is fine; raw appends to
  config files are not). If you cannot make a line idempotent, guard it with a
  check.
- On entering a workspace, if `~/.roomyrc` is non-empty, read it before doing any
  setup-like work, so you do not duplicate or fight prior configuration.
- For the long-form playbook (idempotency patterns, recovery, what counts as
  persistable), load the `roomy-persistence` skill.
