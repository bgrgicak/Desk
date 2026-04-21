# Desk

Monorepo for the Desk personal AI assistant.

- **`packages/server/`** — API, DB, storage, tools, runtime, scheduler, sandbox CLI, setup.
- **`packages/app/`** — minimal React web UI (no CSS, semantic HTML) + Playwright e2e.

The server runs inside an Ubuntu 24.04 VM provisioned by [Lima](https://lima-vm.io)
that installs Docker, Node.js LTS, PostgreSQL 16, `at`, and `cron`, then builds
and launches the API as the `desk-server` systemd unit. Tests split by what
they actually need: API endpoint + Playwright tests run on the host; everything
that needs native `at`/`cron`/Docker/Postgres runs inside the VM.

## Prerequisites

- Node.js and npm (workspace scripts run on the host)
- QEMU + KVM on the host (add yourself to `kvm`: `sudo usermod -aG kvm $USER`)
- [`limactl`](https://lima-vm.io/docs/installation/) on `PATH`
- Docker on the host (for the test Postgres container used by host-side tests)
- `python3` (used by the VM wrapper to derive host ports)
- A `.env` file at the repo root with `ANTHROPIC_API_KEY=…`

## First-time setup

From the repo root:

```bash
npm install                      # workspaces
npm run vm:up                    # boots the VM, runs install.sh + dev-provision.sh
docker run -d --name desk-test-pg \
  -e POSTGRES_PASSWORD=desk -e POSTGRES_USER=desk -e POSTGRES_DB=desk \
  -p 127.0.0.1:55432:5432 postgres:16   # host test DB (for API + Playwright)
npx playwright install chromium  # only if you'll run Playwright on the host
```

`vm:up` boots the VM from [lima.yaml](../../lima.yaml) and runs two scripts:

1. [setup/install.sh](setup/install.sh) — production-style install. Installs
   Docker, Node.js LTS, PostgreSQL 16, `at`, `cron`. Creates the `desk` OS user
   and the `desk` Postgres role + database. Builds every workspace package at
   the repo root and stages the result to `/opt/desk-server/`. Writes
   `/etc/desk-server/env` and the `desk-server.service` systemd unit. Starts
   the service and waits for `http://127.0.0.1:8080/` to answer with
   `hello world`.
2. [setup/dev-provision.sh](setup/dev-provision.sh) — dev-only tweaks. Sets a
   known password on the `desk` Postgres role and adds md5 auth so tests
   running as `bero` can connect over TCP (peer auth for the prod `desk` user
   is preserved). Adds `bero` to the `docker` group. Builds the
   `desk/sandbox:v1` image. Installs Playwright Chromium inside the VM.

Guest port `8080` is forwarded to a host port derived from `DESK_INSTANCE`
(default `dev` → usually `3013`). See [setup/scripts/vm.sh](setup/scripts/vm.sh).

## Day-to-day commands

Run from the repo root.

### VM lifecycle

| Command | What it does |
| --- | --- |
| `npm run vm:up` | Boot the VM and provision if needed |
| `npm run vm:halt` | Shut the VM down |
| `npm run vm:ssh` | SSH into the VM |
| `npm run vm:status` | Show VM status |
| `npm run vm:provision` | Re-run [setup/install.sh](setup/install.sh) |
| `npm run vm:reload` | Reload VM configuration |
| `npm run vm:restore` | Restore the `clean-install` snapshot |
| `npm run vm:reset` | Destroy and re-create the VM |
| `npm run start` / `stop` | Start / stop the `desk-server` service in the VM |
| `npm run logs` | Follow `journalctl -fu desk-server` in the VM |
| `npm run dev` | Swap the service to `tsx watch` on the mounted source and stream logs; reverts on `Ctrl+C` |
| `npm run dev:revert` | Remove the dev override and restart the prod service |

### Build + test

| Command | Where it runs | What it runs |
| --- | --- | --- |
| `npm run build` | host | All workspace packages via Nx |
| `npm run typecheck` | host | tsc on all workspaces |
| `npm run test:host` | host | API endpoint tests (`packages/server/api/test/`) + Playwright (`@desk/app`). 106 tests. |
| `npm run test:vm` | **VM** (via vm.sh exec) | db + storage + tools + scheduler + runtime + setup + shared + sandbox-cli. 237 tests. Uses real at/cron/Docker/native Postgres. |
| `npm run test:e2e` | host (spawns fresh Lima VM) | [setup/test/e2e](setup/test/e2e) — `install.sh` + `dev-override`. Gated by `RUN_VM_TESTS=1`. 5 tests. |
| `npm test` | depends on where you run it | Default Vitest, useful for ad-hoc runs. |

All three suites are green today (343 tests covered + 5 VM-provision e2e).

## Running the demo app on the host

The React app at `packages/app/` talks to the API via same-origin proxy. For a
manual demo or a Postman/curl session, start both on the host:

```bash
# 1. Test Postgres (host)
docker start desk-test-pg   # or run the docker run from First-time setup

# 2. API on port 18080 — uses the host test Postgres
set -a; . ./.env; set +a
DATABASE_URL=postgresql://desk:desk@127.0.0.1:55432/desk_demo \
  PORT=18080 \
  DESK_HOME=/tmp/desk-demo-home \
  DESK_SANDBOX_DRIVER=fake \
  DESK_SEED_USERNAME=demo \
  DESK_SEED_PASSWORD=demo \
  npx tsx packages/server/api/src/main.ts &

# 3. Static app + same-origin proxy on port 14173
DESK_API_PORT=18080 DESK_APP_PORT=14173 \
  npx tsx packages/app/scripts/serve.ts &
```

Open <http://127.0.0.1:14173> — log in as `demo` / `demo`.

`DESK_SANDBOX_DRIVER=fake` means message sends get a canned assistant reply in
~50 ms instead of spawning a real Docker sandbox. Drop it to exercise real
OpenCode + Anthropic (needs the sandbox image from `dev-provision.sh`).

## Manual API testing

### Postman

[`packages/server/docs/desk-api.postman_collection.json`](docs/desk-api.postman_collection.json)
covers every route in
[`api/src/app.ts`](api/src/app.ts). Import it into Postman:

1. Set the collection variables:
   - `baseUrl` = `http://127.0.0.1:14173` (demo setup above) or the VM's
     forwarded port (e.g. `http://127.0.0.1:3013`).
   - `username` / `password` = whatever you seeded.
2. Run **POST /auth/login** first — the test script stores `token` and subsequent
   requests pick it up automatically via collection-level Bearer auth.
3. WebSocket upgrades live at `{{baseUrl}}/ws?token={{token}}`.

### curl

Same endpoints from the command line. Example:

```bash
API=http://127.0.0.1:14173   # or the VM's forwarded port

TOKEN=$(curl -s -X POST $API/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"demo"}' | jq -r .token)

curl -s $API/me -H "Authorization: Bearer $TOKEN"
curl -s $API/workspaces -H "Authorization: Bearer $TOKEN"
curl -s $API/agents -H "Authorization: Bearer $TOKEN"

WS_ID=$(curl -s $API/workspaces -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')
AGT_ID=$(curl -s $API/agents -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')

CHAT=$(curl -s -X POST $API/chats -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WS_ID\",\"agentId\":\"$AGT_ID\",\"title\":\"Curl chat\"}")
CHAT_ID=$(echo "$CHAT" | jq -r .id)

curl -s -X POST $API/chats/$CHAT_ID/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content":"hello"}'

curl -s "$API/search?q=curl&scope=all" -H "Authorization: Bearer $TOKEN"
curl -s $API/openapi.json | jq '.paths | length'
```

## Layout

- [api/](api/) — HTTP + WS server (entry: [api/src/main.ts](api/src/main.ts))
- [db/](db/) — Postgres migrations + typed queries
- [storage/](storage/) — file layout + upload/download
- [tools/](tools/) — host-side tool API called from inside sandboxes
- [runtime/](runtime/) — Docker sandbox lifecycle + OpenCode driver
- [scheduler/](scheduler/) — runs + at/crontab adapter + reconcile
- [sandbox-cli/](sandbox-cli/) — the `desk` binary installed inside sandboxes
- [shared/](shared/) — cross-package types + Zod schemas
- [setup/](setup/) — `install.sh`, `dev-provision.sh`, `dev-override.sh`,
  VM wrapper, VM-spawning e2e tests
- [docs/](docs/) — architecture, OpenAPI spec, Postman collection, plans, notes

## Troubleshooting

- **`desk-server` service keeps failing after a fresh `vm:up`**: check
  `vm:ssh` → `sudo journalctl -u desk-server -n 100 --no-pager`. Common cause:
  a `.env` with bad credentials, or `install.sh` hit a Docker-repo mirror flake
  (re-run `vm:provision`).
- **Host Postgres refusing connections on `:55432`**: `docker start desk-test-pg`
  (the container is persistent but not set to autostart on reboot).
- **Playwright tests hang on `vite build`**: delete `packages/app/dist` and
  retry. vite's incremental cache occasionally gets confused with the monorepo.
- **`docker` commands fail with "permission denied" on the host**: wrap with
  `sg docker -c "..."`, or log out and back in once after `usermod -aG docker`.
