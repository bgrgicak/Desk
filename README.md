# Desk

AI should work for everyone — not just developers who know how to run servers, write config files, or debug why a context window ran out.

Desk is a personal AI platform built around three convictions:

**Your data belongs to you.** Conversations, files, and the context agents build over time live on your machine, in your home directory, under your control. No vendor lock-in, no data siloed in someone else's cloud.

**No single provider should hold you hostage.** Desk is designed to run across any AI provider. When one is down, over-priced, or simply not the best fit anymore, you switch — your workflows, history, and agents stay exactly where they were.

**You shouldn't need to be an AI enthusiast to get a great experience.** Context windows, token limits, agent orchestration, prompt engineering — these are implementation details, not things anyone should have to think about. Desk handles the complexity so you can focus on what you're actually trying to do.

## What we're building

Desk is a place where you define goals and let AI help you reach them — not a chat interface you interact with manually, and not another app builder that requires you to wire things together yourself.

You describe what you want: a workflow that processes your emails each morning, a research assistant that knows your projects, a recurring task that keeps something in sync. Desk turns that into something that runs, remembers context, and gets better over time — without you writing a line of configuration.

The long-term vision is an agentic operating system: a personal environment where AI agents work alongside you, with your data, using tools you've authorized, toward goals you've set. Think less "AI assistant you talk to" and more "intelligent layer on top of your digital life."

## How it's different

Desk is not a Claude or ChatGPT wrapper. It's not a productivity tool with an AI button. It's not a no-code app builder.

Those tools serve different needs. What's missing is something that meets people where they are — gives them the power of AI without demanding technical fluency — while giving them ownership and resilience that cloud-only products can't offer.

---

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
| Node.js 23 + npm (pinned by `.nvmrc` + `engines`) | use [volta](https://volta.sh/), [fnm](https://github.com/Schniz/fnm), [nvm](https://github.com/nvm-sh/nvm), mise, or asdf | use [volta](https://volta.sh/), [fnm](https://github.com/Schniz/fnm), [nvm](https://github.com/nvm-sh/nvm), mise, or asdf |
| Docker | [Docker Desktop](https://www.docker.com/products/docker-desktop/) | rootful or rootless — both auto-detected |
| `python3` | preinstalled | preinstalled |

API keys are configured per-user via Settings after the first sign-in.
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
