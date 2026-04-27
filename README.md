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

## Developer setup

Monorepo for the API server, the React app prototype, and the VM-based dev environment.

- **`packages/server/`** — API, DB, storage, tools, runtime, scheduler, sandbox CLI.
- **`packages/app-prototype/`** — React/Vite UI (talks to the API on the host).

The server runs inside an Ubuntu VM provisioned by [Lima](https://lima-vm.io)
so dev matches prod (real Postgres, Docker, `at`/`cron`). The Vite dev server
runs on the host and proxies to the API forwarded out of the VM.

## Quick start

```bash
git clone git@github.com:bgrgicak/Desk.git
cd Desk
npm run dev
```

That's it — `npm run dev` will install workspace dependencies and boot the
VM on first run (a few minutes the first time, seconds after that), then
start Vite on <http://localhost:5173/> and stream `desk-server` logs from
the VM. `Ctrl+C` stops both and reverts the VM to the prod systemd unit.

## Prerequisites

You need these on the host before `npm run dev`:

| Tool | macOS | Linux |
| --- | --- | --- |
| Node.js 22 LTS + npm | `brew install node@22` | use [nvm](https://github.com/nvm-sh/nvm) or your distro |
| [`limactl`](https://lima-vm.io) | `brew install lima` | see [docs](https://lima-vm.io/docs/installation/) |
| Docker (host-side test DB) | [Docker Desktop](https://www.docker.com/products/docker-desktop/) | distro packages |
| `python3` | preinstalled | preinstalled |

On Linux you also need to be in the `kvm` group (`sudo usermod -aG kvm $USER`,
then log out + back in). On macOS, Lima uses Apple's Virtualization framework
— no extra setup.

> **Node version:** anything on the active LTS line (22 or 24) works. Node 23
> emits engine warnings from a few transitive deps but installs and runs.

## Common commands

Run from the repo root.

| Command | What it does |
| --- | --- |
| `npm run dev` | Start everything — installs deps, boots the VM if needed, runs Vite + streams server logs |
| `npm run vm:up` | Boot the dev VM (first run also provisions it) |
| `npm run vm:halt` | Shut the VM down |
| `npm run vm:ssh` | SSH into the VM |
| `npm run vm:status` | Show VM status |
| `npm run logs` | Follow `journalctl -fu desk-server` inside the VM |
| `npm run build` | Build all workspace packages (Nx) |
| `npm run typecheck` | Run tsc on all workspaces |
| `npm test` | Default Vitest (host-side) |

See [packages/server/README.md](packages/server/README.md) for the full
list and details on the test split (host vs VM), VM lifecycle, and the
manual demo / Postman / curl flows.

## Troubleshooting

- **`sg: command not found` / `VM ... is not running`** — you're on an old
  copy of the setup scripts; pull `trunk`. macOS doesn't have `sg`; the
  scripts now no-op the wrapper there.
- **`limactl: command not found`** — install Lima (see prerequisites). On
  macOS: `brew install lima`.
- **VM boot stalls or fails** — `npm run vm:status`, then `npm run vm:ssh`
  and `sudo journalctl -u desk-server -n 100 --no-pager`. If provisioning
  half-finished, `npm run vm:reset` rebuilds it from scratch.
- **`vite: command not found`** — run `npm install` at the repo root. (As
  of `dev.sh`'s self-bootstrap, `npm run dev` does this for you.)
