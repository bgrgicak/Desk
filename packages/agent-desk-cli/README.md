# @agent-desk/cli

Host CLI for Desk — boots the full server stack locally.

## Usage

```sh
npx @agent-desk/cli@alpha
```

Opens the Desk UI at `http://127.0.0.1:35138/` and keeps it running in the foreground.

## Subcommands

| Command | What it does |
|---|---|
| `desk start` (default) | Boot desk-server on `:35138`. |
| `desk init` | Create `~/Desk` + generate `DESK_VAULT_PASSWORD` without starting the server. |
| `desk service install` | Register Desk as a background service (launchd / systemd-user / Task Scheduler). |
| `desk service start \| stop \| status \| uninstall` | Control the registered service. |
| `desk uninstall [--remove-desk-files]` | Remove the service + `desk/*` container images. Pass `--remove-desk-files` to also delete `~/Desk`. |
| `desk version` | Print the package version. |

## Requirements

- Node.js ≥ 22 (current LTS)
- Docker or nerdctl (for the sandboxed agent runtime)

## License

MIT
