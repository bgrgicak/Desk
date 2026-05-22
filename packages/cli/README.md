# @roomy-ai/cli

Host CLI for Roomy — boots the full server stack locally.

## Usage

```sh
npx @roomy-ai/cli@alpha
```

Opens the Roomy UI at `http://127.0.0.1:35138/` and keeps it running in the foreground.

## Subcommands

| Command | What it does |
|---|---|
| `roomy start` (default) | Boot roomy-server on `:35138`. |
| `roomy init` | Create `~/Roomy` without starting the server. |
| `roomy service install` | Register Roomy as a background service (launchd / systemd-user / Task Scheduler). |
| `roomy service start \| stop \| status \| uninstall` | Control the registered service. |
| `roomy uninstall [--remove-roomy-files]` | Remove the service + `roomy/*` container images. Pass `--remove-roomy-files` to also delete `~/Roomy`. |
| `roomy version` | Print the package version. |

## Requirements

- Node.js ≥ 22 (current LTS)
- Docker or nerdctl (for the sandboxed agent runtime)

## License

MIT
