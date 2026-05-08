# Scheduling

Scheduled messages use an in-process DB polling loop instead of OS `at`/`crontab`.

## How it works

A `setInterval` loop in `packages/server/api/src/main.ts` calls `runManager.tickScheduled()` every 60 seconds (configurable). Each tick queries:

```sql
SELECT id FROM messages
WHERE state = 'pending'
  AND execute_at IS NOT NULL
  AND execute_at <= now()
ORDER BY execute_at
LIMIT $max_concurrent
```

Matched messages are fired concurrently via `fireMessage()`. The DB is the single source of truth — no OS entries, no reconciliation needed.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `DESK_SCHEDULER_POLL_INTERVAL_MS` | `60000` | How often the poll loop runs (ms) |
| `DESK_SCHEDULER_MAX_CONCURRENT` | `10` | Max simultaneous fires per tick |

## Cron tasks

When a task has a `cron` expression, `execute_at` is computed at insert time using `croner`. After each run, `afterTaskRun()` calls `croner` again to advance `execute_at` to the next occurrence. The task stays in `pending` indefinitely.

One-shot tasks (no `cron`) transition to their terminal state (`succeeded`/`failed`) after their single run, and `execute_at` is cleared.

Manual task runs use the same executor but pass `manual: true` to `fireMessage()`. For scheduled task definitions this creates a `task_run` child immediately without consuming the schedule: one-shot tasks keep `execute_at` and return to their prior scheduled state, while cron tasks do not advance to the next occurrence until the scheduler fires them naturally.

## Overdue tasks

Tasks with a past `execute_at` fire naturally on the next tick — no special handling needed. The UI labels them "Overdue since …" client-side in `packages/app/src/store/selectors/runs.ts`.

## Pause / Resume / Cancel

- **Pause**: sets `state = 'paused'`. The poll query skips non-`pending` rows, so the task won't fire until resumed.
- **Resume**: sets `state = 'pending'`. For cron tasks with no `execute_at`, the next occurrence is computed and set.
- **Cancel**: sets `state = 'cancelled'`. The row is kept for history; the poll query never picks it up.

## Summary scheduling

`scheduleSummary(chatId)` deletes any existing pending `summary` request row for the chat and inserts a new one with `execute_at = now() + 30 minutes`. This refreshes the running summary for the chat without deleting completed summary messages.

## Daily Reflection Scheduling

Daily workspace reflection uses the same DB scheduler as recurring tasks. On startup, `ensureDailyReflectionTasks()` creates or repairs one `kind = 'task'` row per workspace with an enabled agent. The row stores `content.type = 'reflection_request'`, a cron expression, and the next `execute_at`.

Reflection rows are task-like: every fire creates a `task_run` child, the parent returns to `pending`, and `execute_at` advances to the next cron occurrence. The default cron is `0 3 * * *`, overridable with `DESK_DAILY_REFLECTION_CRON`; seeding can be disabled with `DESK_DAILY_REFLECTION=off`.

Reflection rows are regular tasks on the Tasks page. Each reflection task owns a dedicated `Workspace reflection` chat for follow-up conversation from the task detail panel; that chat is hidden from the sidebar so system maintenance chats are only reachable through Desk/task surfaces.
