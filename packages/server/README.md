# Desk

Monorepo for the Desk personal AI assistant.

- **`packages/server/`** — API, DB, storage, runtime, scheduler, sandbox CLI, setup scripts.
- **`packages/app/`** — React web UI (no CSS, semantic HTML) + Playwright e2e.
- **`packages/agent-desk-cli/`** — host CLI (`desk` binary).

The full stack runs on the host — no VM, no systemd. The desk-server
process serves the API on `:35138`; the Vite dev server proxies `/api/*`
calls to it on `:5173`. Sandbox containers spawn through the host's
container runtime — `docker` if present, otherwise `nerdctl`
(containerd) — both detected. State lives under `~/Desk/`.

## Prerequisites

- Node.js 23.x (pinned by `.nvmrc` + `engines`). Use volta/fnm/nvm/mise/asdf.
- A container runtime on the host. Either:
  - **Docker** — Linux rootful, Linux rootless, or macOS Docker Desktop
    (auto-detected via the `docker` CLI), OR
  - **nerdctl + containerd** — useful on hosts that already run
    `containerd-rootless` (Lima, Rancher Desktop, standalone) where
    `dockerd-rootless` can't coexist. nerdctl ≥ 2.0 recommended.
  Override the auto-pick with `DESK_CONTAINER_ENGINE=docker|nerdctl`.
- API keys are configured per-user via Settings after the first sign-in.

## First-time setup

```bash
npm install

# Build the sandbox image. Use whichever runtime you have installed:
docker build -f packages/server/runtime/Dockerfile.sandbox \
  -t desk/sandbox:v1 packages/server
# OR (nerdctl with buildkit available):
nerdctl build -f packages/server/runtime/Dockerfile.sandbox \
  -t desk/sandbox:v1 packages/server
```

## Day-to-day commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Boot desk-server (tsx watch) + Vite. Ctrl+C stops both. |
| `npm run dev:app` | Vite only — useful when desk-server is running elsewhere. |
| `npm run build` | All workspace packages via Nx. |
| `npm run typecheck` | tsc on all workspaces. |
| `npm run test:host` | Vitest unit + integration tests. |
| `npm run test:e2e` | Playwright against a spawned desk-server + Vite preview. |

## Layout

- [api/](api/) — HTTP + WS server (entry: [api/src/main.ts](api/src/main.ts))
- [db/](db/) — SQLite migrations + typed queries
- [storage/](storage/) — file layout under `~/Desk/`
- [runtime/](runtime/) — sandbox lifecycle (engine.ts → docker/nerdctl) + OpenCode driver
- [scheduler/](scheduler/) — runs + at/crontab adapter + reconcile
- [sandbox-cli/](sandbox-cli/) — the `desk-agent` binary installed inside sandboxes
- [shared/](shared/) — cross-package types + Zod schemas
- [setup/](setup/) — `dev.sh` host launcher
- [docs/](docs/) — architecture, dev environment, OpenAPI spec, Postman collection, plans

## Manual API testing

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:35138/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"desk","password":"change-me"}' | jq -r .token)

curl -s http://127.0.0.1:35138/me -H "Authorization: Bearer $TOKEN"
```

The Postman collection at
[`packages/server/docs/desk-api.postman_collection.json`](docs/desk-api.postman_collection.json)
covers every route in [`api/src/app.ts`](api/src/app.ts).

## Troubleshooting

- **`desk-server` exits immediately**: check `~/Desk/desk.db` for stale
  state, and inspect the logs. Migrations run idempotently on every
  boot — a corrupt schema row from a partial earlier run can wedge them.
- **`docker` commands fail with "permission denied" on the host**: wrap
  with `sg docker -c "..."`, or log out and back in once after
  `usermod -aG docker $USER`.
- **`No container runtime available` on boot**: the runtime probes
  `docker info` and `nerdctl info` in that order; install one of them,
  or set `DESK_CONTAINER_ENGINE=docker|nerdctl` if both are present and
  you want to force a choice. nerdctl rootless typically also needs
  `XDG_RUNTIME_DIR` exported (the runtime defaults to `/run/user/$UID`
  if you don't set it).
- **`dockerd-rootless` won't start because `containerd-rootless` is
  already running**: rootlesskit only supports one user-namespace per
  uid, so the two daemons can't coexist. Use the one that's already
  running (the runtime will pick it up automatically), stop the other
  one, or run rootful Docker (`sudo systemctl start docker`).
- **Sandbox bind-mount writes fail under a rootless runtime**: the
  runtime detects rootless mode and runs the container as UID 0 (which
  maps to the daemon's host uid). If it ever doesn't, set
  `DESK_SANDBOX_USER=0:0` to pin the override.

See [`docs/dev-environment.md`](docs/dev-environment.md) for more depth.
