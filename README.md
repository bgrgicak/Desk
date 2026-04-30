# Desk

Monorepo for the API server, the React app prototype, and the host CLI.

- **`packages/server/`** — API, DB, storage, tools, runtime, scheduler, sandbox CLI, setup scripts.
- **`packages/app-prototype/`** — React/Vite UI (proxies `/api/*` to the server).
- **`packages/agent-desk-cli/`** — host CLI (`desk` binary).

The full stack runs on the host — no VM, no systemd. `desk-server` serves
the API on `:35138`; the Vite dev server runs on `:5173` and proxies
`/api/*` to it. Sandbox containers spawn against the host Docker daemon
(rootful and rootless are auto-detected). State lives under `~/Desk/`.

## Quick start

```bash
git clone git@github.com:bgrgicak/Desk.git
cd Desk
npm install
docker build -f packages/server/runtime/Dockerfile.sandbox \
  -t desk/sandbox:v1 packages/server
npm run dev
```

`npm run dev` boots `desk-server` (tsx watch) and Vite together; one
`Ctrl+C` stops both. Open <http://localhost:5173/>.

## Prerequisites

| Tool | macOS | Linux |
| --- | --- | --- |
| Node.js 22 LTS + npm (pinned by `.nvmrc` + `engines`) | `brew install node@22` | use [nvm](https://github.com/nvm-sh/nvm)/fnm/mise/asdf |
| Docker | [Docker Desktop](https://www.docker.com/products/docker-desktop/) | rootful or rootless — both auto-detected |
| `python3` | preinstalled | preinstalled |

A `.env` at the repo root must contain at least `ANTHROPIC_API_KEY=…`.
`dev.sh` generates `DESK_SECRET_KEY` into `.env` on first run.

## Common commands

Run from the repo root.

| Command | What it does |
| --- | --- |
| `npm run dev` | Boot `desk-server` + Vite. |
| `npm run dev:app` | Vite only — useful when `desk-server` runs elsewhere. |
| `npm run build` | Build all workspace packages (Nx). |
| `npm run typecheck` | Run tsc on all workspaces. |
| `npm run test:host` | Vitest unit + integration tests. |
| `npm run test:e2e` | Playwright against a spawned `desk-server` + Vite preview. |

See [packages/server/README.md](packages/server/README.md) for the full
package layout, manual API/Postman flow, and deeper dev notes; see
[packages/server/docs/dev-environment.md](packages/server/docs/dev-environment.md)
for the host-only setup specifics (Docker socket detection, sandbox
UID, etc.).

## Troubleshooting

- **`desk-server` exits immediately** — inspect logs and check `~/Desk/`
  for stale state. Migrations run idempotently on every boot, but a
  half-applied earlier run can wedge them.
- **`docker` commands fail with permission denied (Linux)** — log out
  and back in once after `sudo usermod -aG docker $USER`, or wrap with
  `sg docker -c "..."`.
- **Sandbox bind-mount writes fail under rootless docker** — the
  runtime detects rootless mode and runs the container as UID 0. If it
  doesn't, pin via `DESK_SANDBOX_USER=0:0`.
- **`vite: command not found`** — run `npm install` at the repo root.
