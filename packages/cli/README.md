# @roomy-ai/cli

Host CLI for Roomy — boots the full server stack locally.

## Usage

```sh
npx @roomy-ai/cli
```

Opens the Roomy UI at `http://127.0.0.1:35138/` and keeps it running in the foreground.

## Subcommands

| Command | What it does |
|---|---|
| `roomy start` (default) | Boot roomy-server on `:35138`. |
| `roomy init` | Create `~/Roomy` without starting the server. |
| `roomy service install` | Register Roomy as a background service (launchd / systemd-user / Task Scheduler). |
| `roomy service start \| stop \| status \| uninstall` | Control the registered service. |
| `roomy service update [--tag=<tag>]` | Update a published install from npm and restart the service. |
| `roomy service update --source <repo>` | Build a local Roomy checkout into `ROOMY_HOME/current`, then restart the service. |
| `roomy uninstall [--remove-roomy-files]` | Remove the service + `roomy/*` container images. Pass `--remove-roomy-files` to also delete `~/Roomy`. |
| `roomy version` | Print the package version. |

`--source` treats the checkout as deployment input: the CLI copies it into a
staged release directory, runs `npm ci`, `npm run build`, and the sandbox
image build there, then moves `ROOMY_HOME/current` only after the build succeeds.
If the build fails, the service keeps running the previous release.

## Requirements

- Node.js ≥ 22 (current LTS)
- Docker or nerdctl (for the sandboxed agent runtime)

## License

MIT
