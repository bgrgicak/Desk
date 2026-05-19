# ADR-0001: Tasks live as `messages.kind=task`

**Status**: Accepted (2026-05-18)
**Roadmap**: A3.4 (tasks-first-class prerequisite)

## Context

The roadmap's "agent autonomy & scheduled runs" track (A3.*) lands
scheduled task triggers, event triggers, and run-history review.
Three modelling shapes are on the table:

1. **Tasks are messages**: a row in `messages` with
   `kind='task'`, schedule columns (`execute_at`, `cron`),
   per-run children that themselves are messages with
   `kind='task_run'`. The current model.
2. **Tasks are a first-class table**: `tasks` + `task_runs` with
   FK back to a chat. Runs append a per-run message into the chat
   thread for display.
3. **Hybrid**: tasks are first-class but the display-side payload
   is still on the `messages` row that triggered them.

Forces in play:
- Recurrence: cron-shaped tasks need a next-execution computation
  + state-machine semantics (paused / scheduled / cancelled).
- Dependencies: phase A3.4 anticipates "task B fires after task A
  completes," which (1) handles awkwardly because messages have
  no native dependency edge.
- Agent ownership: a task can be created by a human OR by an
  agent; (1) already supports either because `messages.role` is
  agnostic.
- Display: every task surfaces in Today/Inbox + the chat thread.
  (1) gets that for free because every task IS a message. (2)
  has to duplicate.
- Migration cost: (2) is the most disruptive — every Today/Inbox
  selector, every WS event, every search index has to learn about
  a second table.

## Decision

Keep tasks as `messages.kind=task`. Extend the row with the
fields the autonomy track needs (`dependencies` JSON array of
parent-message-ids, `last_completed_at`) instead of lifting them
into a separate table.

## Consequences

- Recurrence stays in scheduler/runs.ts (existing home) using
  croner; no new tables.
- Dependencies surface as a JSON column scanned at fire time. If
  the dependency graph grows past trivial fan-out (~10 parents
  per task), revisit — the JSON column doesn't index well.
- The "messages.kind=task" assumption is now load-bearing in
  Today/Inbox/search. Any change to message-shape ripples across
  more code than it would if tasks were separated.
- Run history is already in the message thread — no separate
  `task_runs` viewer needed; the chat IS the run history.

## Alternatives considered

(2) was rejected on migration cost: the search / Today / WS event
matrix touches messages in 20+ places, and the duplication cost
to keep tasks aligned would dominate the cleaner schema benefit.

(3) was rejected on conceptual complexity: explaining why a task
is "kind of a message but also a row in tasks" is harder than
explaining "tasks are messages."

## Reversal cost

If the dependency graph grows past what JSON-scan supports, the
reversal path is to introduce a `task_dependencies` join table
keyed by message-id, NOT to lift tasks into a separate table.
