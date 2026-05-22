# Examples

Process-supervision recipes for running `roomy-server` 24/7 on a host.
Each file is a starting point — edit the paths, user/group, and env
file location for your install.

| File | Use |
| --- | --- |
| [`systemd/roomy-server.service`](systemd/roomy-server.service) | Linux systemd service (system-wide or per-user). Wires graceful-shutdown via SIGTERM + the standard ProtectSystem / ProtectKernelTunables / RestrictNamespaces hardening flags. |
| [`launchd/com.roomy.server.plist`](launchd/com.roomy.server.plist) | macOS user-agent. RunAtLoad + KeepAlive so it survives logout/login. |

## Health-check probes

All recipes assume `roomy-server` exposes the unauthenticated probes
landed in this PR:

- `GET /health` — process is up.
- `GET /ready` — DB + vault dependencies are responsive (HTTP 503 if
  not).

A reverse proxy or external watchdog should hit `/ready` (not
`/health`) when deciding whether to send traffic. The systemd unit
does not configure healthcheck retries — add a separate
`systemd-healthcheck@.service` template or use a sidecar container if
you need the kill-on-unhealthy behaviour.

## Backups

`roomy-server` snapshots `roomy.sqlite3` before every migration to
`${ROOMY_HOME}/backups/pre-migration-<ts>.db` (retention bounded by
`ROOMY_PRE_MIGRATION_BACKUP_KEEP`, default 10). For periodic snapshots
between migrations, hit `POST /internal/backup` from a cron — it
takes a `VACUUM INTO` snapshot on the running connection so no
downtime. See `packages/server/docs/BACKUP.md`.
