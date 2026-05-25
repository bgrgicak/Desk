# Dev environment (host)

Roomy runs entirely on the host. No VM, no Lima, no systemd. The sandbox
containers spawn through whichever container runtime the host has —
Docker by default, nerdctl + containerd as a drop-in alternative. State
lives under `~/Roomy/`.

## Prerequisites

- Node.js 23.x (pinned by [.nvmrc](../../.nvmrc) + `engines`).
  Use nvm/fnm/mise/asdf so the pin picks up automatically.
- A container runtime. One of:
  - **Docker** — rootful (`/var/run/docker.sock`) or rootless
    (`$XDG_RUNTIME_DIR/docker.sock`); macOS Docker Desktop also works.
  - **nerdctl + containerd** — useful if you already run
    `containerd-rootless` (Lima, Rancher Desktop, standalone) and
    can't add a second rootless daemon. nerdctl ≥ 2.0 recommended.
  Detection lives in
  [`packages/server/runtime/src/engine.ts`](../runtime/src/engine.ts);
  override the auto-pick with `ROOMY_CONTAINER_ENGINE=docker|nerdctl`.
- An optional `.env` file at the repo root (gitignored) for any
  Roomy env vars you want auto-loaded by the dev script. AI-provider
  API keys are configured per-user via global account settings →
  Models, not via this file.

### GitHub connection setup

Workspace Settings → Connections → GitHub currently uses a classic personal access token.
Users create one in GitHub → **Settings** → **Developer settings** →
**Personal access tokens** → **Tokens (classic)** with the `repo` scope, plus
`workflow` if agents should edit GitHub Actions workflow files. Roomy stores that
token encrypted as `GITHUB_TOKEN`. The token is forwarded to a sandbox as both
`GITHUB_TOKEN` and `GH_TOKEN` only after the active workspace grants that
connection.

## First-time setup

```bash
git clone <this repo>
cd <repo root>
npm install
# Build the sandbox image (one-time, ~3 min — pulls node + pi).
# Use whichever runtime is available:
docker build -f packages/server/runtime/Dockerfile.sandbox \
  -t roomy/sandbox:v1 .
# OR (nerdctl with buildkit installed):
nerdctl build -f packages/server/runtime/Dockerfile.sandbox \
  -t roomy/sandbox:v1 .
```

## Daily dev loop

```bash
npm run dev
```

That:

1. Ensures `~/Roomy/` exists.
2. Builds missing built-in app `dist/` directories, including any required
   workspace package outputs such as `@roomy-ai/ui/dist`.
3. Starts `roomy-server` (tsx watch) on http://127.0.0.1:35138/.
4. Starts the Vite dev server on http://127.0.0.1:5173/.
5. Wires Vite's `/api/*` proxy to `:35138`.

One Ctrl+C kills both.

The new launcher is implemented by [`packages/server/setup/scripts/dev.sh`](../setup/scripts/dev.sh).
A Node-based equivalent ships as `roomy start` in
[`@roomy-ai/cli`](../../cli/) — same behaviour, different
entry point.

## Sandbox containers

Containers spawn through `engine.ts` against `roomy/sandbox:v1`. Engine
selection (cached for the process lifetime) goes:

1. `ROOMY_CONTAINER_ENGINE=docker|nerdctl` env override.
2. `docker info` returns 0 → docker.
3. `nerdctl info` (with `XDG_RUNTIME_DIR` populated) returns 0 → nerdctl.
4. Throw with a setup message naming both binaries.

Both engines share one CLI shim. `docker` and `nerdctl` accept nearly
identical flags for the operations Roomy needs (`run`, `exec`, `inspect`,
`ps`, `image inspect`, `pull`, `top`, `stop`, `rm`), so one
implementation parameterised by binary name covers both.

The long-lived container starts as root so the entrypoint can configure the
runtime `agent` user and passwordless sudo. Agent commands then run as
`--user $(id -u):$(id -g)` of the roomy-server process — except under a rootless
runtime, where they run as `0:0` (host uid → user-namespace root inside the
container). See [`sandboxUser()` in runtime/src/docker.ts](../runtime/src/docker.ts)
for the rationale. Override via `ROOMY_SANDBOX_USER` if a custom daemon needs
something else.

The image bakes a baseline `agent` user at UID 2000 for `docker run` without
Roomy. At Roomy runtime, the entrypoint rewires that user to the host uid/gid when
needed, which keeps ordinary workspace writes symmetric while still allowing
agents to install system packages with `sudo apt-get ...`.

On container start, the sandbox entrypoint seeds `/etc/skel` dotfiles into the
workspace home and then runs `~/.roomyrc` if present. That file is the
agent-maintained persistence recipe for setup outside the bind-mounted home;
failures are logged to container stdout and do not block the sandbox from
starting.

## Tests

```bash
npm run test:host   # unit + integration (vitest)
npm run test:e2e    # Playwright e2e
```

Both run against real backends — real container runtime, real SQLite.
There is no `test:vm` anymore: everything that used to require
Docker-in-VM now requires a host-side runtime, which is the same
prerequisite locally and on GitHub Actions runners. Tests that need the
sandbox image auto-skip when `roomy/sandbox:v1` isn't present locally.

## Rolling back to the VM

The VM scripts (lima.yaml, install.sh, dev-provision.sh, vm.sh,
dev-override.sh) were removed in commit `feat/drop-vm`. Restore them
from git history if you need the old topology — but the trade we made
(personal-use trust boundary becomes Docker hardening on the host) was
deliberate. See [`plans/drop-vm.md`](plans/drop-vm.md) for context.
