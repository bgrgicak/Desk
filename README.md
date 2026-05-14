# Desk

AI should work for everyone — not just developers who know how to run servers, write config files, or debug why a context window ran out.

Desk is a personal AI platform that runs entirely on your machine. Your conversations, files, and agent memory stay local. You pick the AI provider. You own the data.

![Desk workspace](docs/screenshots/workspace.png)

## What you get

**Workspaces** — separate contexts for different projects or roles. Switch between them from the tab bar at the top. Each workspace has its own chats, tasks, and library.

**Chat with threads** — every message can branch into a focused thread. The original conversation keeps going; the thread explores the tangent. Both live in the same chat.

![Active chat with thread](docs/screenshots/chat-active.png)

**Tasks board** — agents create and track tasks as they work. You see what's queued, what's running, what's scheduled, and what finished — without having to ask.

![Tasks board](docs/screenshots/tasks.png)

**Library** — a file browser for everything the agent has built or been given access to. Documents, apps, images — searchable and pinnable to any workspace.

![Library](docs/screenshots/library.png)

**Artifacts** — when you ask for a document, app, or design, the result appears in the artifact panel alongside the chat. Live-preview React apps run right there in the browser.

**Memory** — agents reflect on past conversations and build up context over time. You don't have to re-explain who you are or what you're working on every session.

**Secrets vault** — API keys and credentials are stored encrypted on disk, scoped per workspace. Agents can use them without you pasting tokens into prompts.

**Connections** — bring in local sources like Codex, or authenticate with GitHub PAT for agent sandbox access.

**Scheduled tasks** — set something to run on a cron schedule; Desk keeps it going in the background.

## Quick start

### As an end user (alpha CLI)

```bash
npx @agent-desk/cli@alpha
```

Opens Desk at `http://127.0.0.1:35138/`. Requires Node.js 23 and Docker.

### From source (contributors / dev)

```bash
git clone git@github.com:bgrgicak/Desk.git
cd Desk
npm install
docker build -f packages/server/runtime/Dockerfile.sandbox -t desk/sandbox:v1 .
npm run dev
```

Open <http://localhost:5173/>. Sign in with username `desk` and the password from `DESK_SEED_PASSWORD` (default: `change-me-before-first-boot`).

`npm run dev` boots `desk-server` (tsx watch) and Vite together; one `Ctrl+C` stops both.

## Prerequisites

| Tool | macOS | Linux |
|---|---|---|
| Node.js 23 + npm | [volta](https://volta.sh/), [fnm](https://github.com/Schniz/fnm), [nvm](https://github.com/nvm-sh/nvm), mise, or asdf | same |
| Docker | [Docker Desktop](https://www.docker.com/products/docker-desktop/) | rootful or rootless — both auto-detected |

AI provider API keys are configured per-user in Settings after first sign-in.

## Common commands

Run from the repo root.

| Command | What it does |
|---|---|
| `npm run dev` | Boot `desk-server` + Vite |
| `npm run dev:app` | Vite only — useful when `desk-server` runs elsewhere |
| `npm run build` | Build all workspace packages |
| `npm run typecheck` | Run tsc across all workspaces |
| `npm run test:host` | Vitest unit + integration tests |
| `npm run test:e2e` | Playwright e2e against a spawned server + Vite preview |
| `npm run ci:local` | Full local CI mirror (requires Node 23 + Docker) |

## Package layout

| Package | Purpose |
|---|---|
| `packages/app` | React/Vite UI |
| `packages/ui` | Shared component library |
| `packages/agent-desk-cli` | `npx @agent-desk/cli` host binary |
| `packages/server/api` | HTTP API server |
| `packages/server/db` | Schema, migrations, query helpers (SQLite) |
| `packages/server/runtime` | Docker sandbox runner |
| `packages/server/scheduler` | Cron + event-driven job scheduler |
| `packages/server/storage` | Local filesystem abstraction |
| `packages/server/shared` | Types and utilities shared across server packages |

State lives under `~/Desk/`. The full stack runs on the host — no VM, no systemd.

## Troubleshooting

- **`desk-server` exits immediately** — check `~/Desk/` for stale state. Migrations are idempotent but a half-applied run can wedge them.
- **`docker` fails with permission denied (Linux)** — log out and back in after `sudo usermod -aG docker $USER`, or wrap with `sg docker -c "..."`.
- **Sandbox bind-mount writes fail under rootless Docker** — the runtime auto-detects rootless and runs the container as UID 0. If it doesn't, set `DESK_SANDBOX_USER=0:0`.
- **`vite: command not found`** — run `npm install` at the repo root.

## License

MIT
