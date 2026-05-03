# Dev environment (host)

Desk runs entirely on the host. No VM, no Lima, no systemd. The sandbox
containers spawn through whichever container runtime the host has —
Docker by default, nerdctl + containerd as a drop-in alternative. State
lives under `~/Desk/`.

## Prerequisites

- Node.js 22.x (pinned by [.nvmrc](../../.nvmrc) + `engines`).
  Use nvm/fnm/mise/asdf so the pin picks up automatically.
- A container runtime. One of:
  - **Docker** — rootful (`/var/run/docker.sock`) or rootless
    (`$XDG_RUNTIME_DIR/docker.sock`); macOS Docker Desktop also works.
  - **nerdctl + containerd** — useful if you already run
    `containerd-rootless` (Lima, Rancher Desktop, standalone) and
    can't add a second rootless daemon. nerdctl ≥ 2.0 recommended.
  Detection lives in
  [`packages/server/runtime/src/engine.ts`](../runtime/src/engine.ts);
  override the auto-pick with `DESK_CONTAINER_ENGINE=docker|nerdctl`.
- A `.env` file at the repo root with an `ANTHROPIC_API_KEY=…`
  (gitignored). The dev script generates `DESK_SECRET_KEY` on first
  run and appends it here.

## First-time setup

```bash
git clone <this repo>
cd <repo root>
npm install
# Build the sandbox image (one-time, ~3 min — pulls node + opencode).
# Use whichever runtime is available:
docker build -f packages/server/runtime/Dockerfile.sandbox \
  -t desk/sandbox:v1 packages/server
# OR (nerdctl with buildkit installed):
nerdctl build -f packages/server/runtime/Dockerfile.sandbox \
  -t desk/sandbox:v1 packages/server
```

## Daily dev loop

```bash
npm run dev
```

That:

1. Generates `DESK_SECRET_KEY` into `.env` if missing.
2. Ensures `~/Desk/` exists.
3. Starts `desk-server` (tsx watch) on http://127.0.0.1:35138/.
4. Starts the Vite dev server on http://127.0.0.1:5173/.
5. Wires Vite's `/api/*` proxy to `:35138`.

One Ctrl+C kills both.

The new launcher is implemented by [`packages/server/setup/scripts/dev.sh`](../setup/scripts/dev.sh).
A Node-based equivalent ships as `desk start` in
[`@agent-desk/cli`](../../agent-desk-cli/) — same behaviour, different
entry point.

## Sandbox containers

Containers spawn through `engine.ts` against `desk/sandbox:v1`. Engine
selection (cached for the process lifetime) goes:

1. `DESK_CONTAINER_ENGINE=docker|nerdctl` env override.
2. `docker info` returns 0 → docker.
3. `nerdctl info` (with `XDG_RUNTIME_DIR` populated) returns 0 → nerdctl.
4. Throw with a setup message naming both binaries.

Both engines share one CLI shim. `docker` and `nerdctl` accept nearly
identical flags for the operations Desk needs (`run`, `exec`, `inspect`,
`ps`, `image inspect`, `pull`, `top`, `stop`, `rm`), so one
implementation parameterised by binary name covers both.

Per-run, the container is started with `--user $(id -u):$(id -g)` of the
desk-server process — except under a rootless runtime, where it's `0:0`
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

Both run against real backends — real container runtime, real SQLite.
There is no `test:vm` anymore: everything that used to require
Docker-in-VM now requires a host-side runtime, which is the same
prerequisite locally and on GitHub Actions runners. Tests that need the
sandbox image auto-skip when `desk/sandbox:v1` isn't present locally.

## Rolling back to the VM

The VM scripts (lima.yaml, install.sh, dev-provision.sh, vm.sh,
dev-override.sh) were removed in commit `feat/drop-vm`. Restore them
from git history if you need the old topology — but the trade we made
(personal-use trust boundary becomes Docker hardening on the host) was
deliberate. See [`plans/drop-vm.md`](plans/drop-vm.md) for context.
