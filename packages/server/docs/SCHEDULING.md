# Scheduling and the stuck-run sweep

A pending scheduled message (`messages.state = 'pending'`) relies on the
Unix `at`/`crontab` daemon to curl `POST /internal/messages/fire` at its
`execute_at`. Several things can silently drop that fire:

- VM/server was down at the trigger time (`at` does not retroactively
  run missed jobs).
- Daemon lost the queue file (VM rebuilt, spool wiped).
- Server was restarting when the curl arrived — `curl -sf` fails and
  the at-job is consumed regardless.

In all of these, the message sits in `pending` with a past `execute_at`.
The UI labels it "Overdue since …" client-side in
`packages/app-prototype/src/store/selectors/runs.ts`; there is no
persisted `overdue` status.

## Repair

`packages/server/scheduler/src/reconcile.ts` exposes:

- `sweepStaleRuns(pool, adapter)` — for each pending message, reinstall
  missing at/cron entries and reschedule overdue at-jobs as `"now"` so
  the daemon fires them on its next tick. Idempotent.
- `reconcile(pool, adapter)` — `sweepStaleRuns` plus a boot-only
  garbage-collect of orphan at/cron entries no pending message
  references.

`fireMessage` is idempotent via `claimPending`, so a racing fire from a
stale entry that happens to still be queued is harmless.

## When it runs

- Boot: `packages/server/api/src/main.ts` calls `reconcile()` before the
  HTTP server starts listening.
- Periodic: `main.ts` installs a `setInterval` calling `sweepStaleRuns()`
  every 5 minutes. Override with `DESK_SCHEDULER_SWEEP_INTERVAL_MS`
  (milliseconds). In-process on purpose — matches the existing
  `retentionTimer`, no HTTP hop, no orphan crontab lines.

## Not handled

- **Cron catch-up.** A `cron` schedule that missed N ticks resumes at
  the next tick; missed occurrences are not backfilled. Matches the
  Unix cron daemon itself.
- **Creation with a past `execute_at`.** The adapter still hands it to
  `at`, which may reject or silently drop. The first sweep picks it up
  within the sweep interval.
