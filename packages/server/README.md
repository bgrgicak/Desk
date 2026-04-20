# Desk Server

The Desk server runs inside an Ubuntu 24.04 VM provisioned by [Lima](https://lima-vm.io).
The VM installs Docker, Node.js LTS, and PostgreSQL 16, then builds and
launches the API as the `desk-server` systemd unit.

## Prerequisites

- Node.js and `npm` (workspace scripts run on the host)
- QEMU + KVM on the host (`qemu-system-x86` and `/dev/kvm` accessible; add
  yourself to the `kvm` group with `sudo usermod -aG kvm $USER`)
- [`limactl`](https://lima-vm.io/docs/installation/) on `PATH`
- `python3` (used by the VM wrapper to derive host ports)

## First-time setup

From the repository root:

```bash
npm install
npm run vm:up
```

`vm:up` boots the VM from [lima.yaml](../../lima.yaml) and runs
[setup/install.sh](setup/install.sh), which:

1. Installs Docker, Node.js LTS, and PostgreSQL 16.
2. Creates the `desk` system user and the `desk` Postgres role and database.
3. Builds the API from [api/](api/) and installs it to `/opt/desk-server`.
4. Writes `/etc/desk-server/env` and the `desk-server.service` systemd unit.
5. Starts the service and waits for `http://127.0.0.1:8080/` to respond.

Guest port `8080` is forwarded to a host port derived from `DESK_INSTANCE`
(defaults to `dev`, giving a host port in the `3000`–`3099` range — see
[setup/scripts/vm.sh](setup/scripts/vm.sh)).

## Day-to-day commands

Run these from the repo root:

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
| `npm run start` / `stop` | Start or stop the `desk-server` service |
| `npm run logs` | Follow `journalctl -fu desk-server` |
| `npm run dev` | Swap the service to `tsx watch` on the mounted source and stream logs; reverts on `Ctrl+C` |
| `npm run dev:revert` | Remove the dev override and restart the prod service |
| `npm run build` | Build all workspace packages via Nx |
| `npm run typecheck` | Type-check all workspace packages |
| `npm run test` | Run unit tests with Vitest |
| `npm run test:e2e` | Run end-to-end tests against the running VM |

## Running multiple instances

Set `DESK_INSTANCE` to spin up an isolated VM with its own host port:

```bash
DESK_INSTANCE=feature-x npm run vm:up
DESK_INSTANCE=feature-x npm run dev
```

## Layout

- [api/](api/) — the server source built and deployed by the installer
- [setup/](setup/) — VM provisioning script, dev override, and e2e tests
- [docs/](docs/) — architecture, plans, and working notes
