# Dev environment (host)

Desk now runs entirely on the host. No VM, no Lima, no systemd. The
sandbox containers spawn against the host's Docker daemon. State lives
under `~/Desk/`.

## Prerequisites

- Node.js 22.x (pinned by [.nvmrc](../../.nvmrc) + `engines`).
  Use nvm/fnm/mise/asdf so the pin picks up automatically.
- Docker — rootful (`/var/run/docker.sock`) or rootless
  (`$XDG_RUNTIME_DIR/docker.sock`). Both are detected automatically by
  [`packages/server/runtime/src/docker.ts`](../runtime/src/docker.ts).
- A `.env` file at the repo root with an `ANTHROPIC_API_KEY=…`
  (gitignored). The dev script generates `DESK_SECRET_KEY` on first
  run and appends it here.

## First-time setup

```bash
git clone <this repo>
cd <repo root>
npm install
# Build the sandbox image (one-time, ~3 min — pulls node + opencode):
docker build -f packages/server/runtime/Dockerfile.sandbox \
  -t desk/sandbox:v1 packages/server
```

## Daily dev loop

```bash
npm run dev
```

That:

1. Generates `DESK_SECRET_KEY` into `.env` if missing.
2. Ensures `~/Desk/` exists.
3. Starts `desk-server` (tsx watch) on http://127.0.0.1:8080/.
4. Starts the Vite dev server on http://127.0.0.1:5173/.
5. Wires Vite's `/api/*` proxy to `:8080`.

One Ctrl+C kills both.

The new launcher is implemented by [`packages/server/setup/scripts/dev.sh`](../setup/scripts/dev.sh).
A Node-based equivalent ships as `desk start` in
[`@agent-desk/cli`](../../agent-desk-cli/) — same behaviour, different
entry point.

## Sandbox containers

Containers spawn against the host Docker daemon at
`desk/sandbox:v1`. The runtime detects the docker socket via:

1. `DOCKER_HOST` env (unix:// only).
2. `docker context inspect` for the active context.
3. `/var/run/docker.sock` (rootful Linux).
4. `~/.docker/run/docker.sock` (macOS Docker Desktop).

Per-run, the container is started with `--user $(id -u):$(id -g)` of the
desk-server process — except under rootless docker, where it's `0:0`
(host uid → user-namespace root inside the container). See
[`sandboxUser()` in runtime/src/docker.ts](../runtime/src/docker.ts) for
the rationale. Override via `DESK_SANDBOX_USER` if a custom daemon needs
something else.

The image bakes a baseline `agent` user at UID 2000, but that's only a
fallback for `docker run` without a `--user` override. The real uid at
runtime is the host's, which keeps reads/writes through the workspace
bind-mount symmetric without any chown dance.

## Tests

```bash
npm run test:host   # unit + integration (vitest)
npm run test:e2e    # Playwright e2e
```

Both run against real backends — real Docker, real SQLite. There is no
`test:vm` anymore: everything that used to require Docker-in-VM now
requires Docker-on-host, which is the same prerequisite locally and on
GitHub Actions runners.

## Rolling back to the VM

The VM scripts (lima.yaml, install.sh, dev-provision.sh, vm.sh,
dev-override.sh) were removed in commit `feat/drop-vm`. Restore them
from git history if you need the old topology — but the trade we made
(personal-use trust boundary becomes Docker hardening on the host) was
deliberate. See [`plans/drop-vm.md`](plans/drop-vm.md) for context.
