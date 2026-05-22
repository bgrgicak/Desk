# Desk persistence playbook

Use `~/.deskrc` when setup work must survive sandbox restarts. The workspace is
bind-mounted at `/home/agent`, so `~/.deskrc` persists; packages, global tools,
system config, and files elsewhere in the container do not.

## Core rules

- Read `~/.deskrc` before setup-like work if it exists and is non-empty.
- Run setup commands in the current container when the current task needs them;
  always append the idempotent form to `~/.deskrc` immediately for future starts.
- There are no ephemeral package installs. After any package-manager command
  that modifies the environment, including `apt-get install`, `pip install`,
  `npm install -g`, or similar, always add the idempotent install command to
  `~/.deskrc` immediately; do not ask first, and do not treat persistence as
  optional follow-up work.
- Installing a package without persisting it in `~/.deskrc` is an incomplete
  action.
- Beyond package installs, append only commands that are useful beyond the
  current task.
- Every entry in `~/.deskrc` must be safe to run repeatedly.
- Use `sudo` for root-only setup commands. On rootless Docker you may already be
  root, but `sudo` is available for the normal rootful path.
- Prefer explicit shell with `set -e` only inside guarded blocks. A failing
  `.deskrc` command logs to container stdout and startup continues, but failures
  still cost future debugging time.

## What to persist

- System packages needed across runs, such as compilers, CLIs, libraries, and
  daemons installed with `apt`.
- Global tools installed outside `~/`, such as `npm install -g`, `corepack`
  package-manager setup, or language toolchains.
- Persistent daemons or services that must be reconfigured on each container
  start.
- MCP server registrations and other global agent/tool configuration.
- Dotfile or system-file edits outside `~/` that the user will expect to keep.

## What not to persist

- Task-specific scratch files.
- Per-project dependencies installed under the workspace, such as local
  `node_modules/`, virtualenvs, generated assets, or build outputs.
- One-off debugging commands whose output is not needed after restart.
- Secrets copied into commands. Store secrets in the intended provider/config
  mechanism, not inline in `~/.deskrc`.

## Idempotency patterns

### apt packages

Use noninteractive package installation and include `apt-get update` in the same
line or guarded block:

```sh
sudo apt-get update && sudo apt-get install -y --no-install-recommends jq ripgrep
```

### npm global tools

Pin when repeatability matters. Plain reinstall is acceptable for global tools:

```sh
npm install -g vercel@latest --omit=dev --loglevel=error
```

### Directories and file installs

Create directories before writing files. Prefer overwriting a deterministic file
over appending:

```sh
mkdir -p /etc/example && install -m 0644 "$HOME/example.conf" /etc/example/config
```

### Dotfile edits

Never use raw `>>` without a guard. Use `grep -qxF` or rewrite a managed block:

```sh
grep -qxF 'export FOO=bar' /etc/profile || printf '%s\n' 'export FOO=bar' >> /etc/profile
```

### MCP server registrations

Prefer commands that replace or upsert a named server. If the tool only appends,
guard the append by checking for the server name first:

```sh
pi mcp add browser --command playwright-mcp || true
```

If a command is not naturally idempotent, wrap it in an existence check against
the actual resource it creates.

## Recovery flow

1. Read `~/.deskrc` before changing setup history.
2. If a line fails on attach, reproduce the failing command manually and inspect
   the error.
3. Prefer editing the failing line into an idempotent, guarded form instead of
   deleting history.
4. Ask the user before removing old entries unless they are clearly broken,
   obsolete, or unsafe.
5. After repair, run the edited command manually once when possible so the
   current container matches future restarts.

## Correct entries

```sh
sudo apt-get update && sudo apt-get install -y --no-install-recommends imagemagick
npm install -g @modelcontextprotocol/server-filesystem@latest --omit=dev --loglevel=error
mkdir -p /opt/tools && curl -fsSL https://example.test/tool.sh -o /opt/tools/tool.sh && chmod +x /opt/tools/tool.sh
grep -qxF 'export PATH=/opt/tools:$PATH' /etc/profile || printf '%s\n' 'export PATH=/opt/tools:$PATH' >> /etc/profile
```

## Incorrect entries

```sh
apt install imagemagick
printf '%s\n' 'export PATH=/opt/tools:$PATH' >> /etc/profile
curl https://example.test/install.sh | sh
echo "$API_TOKEN" > /etc/service-token
```
