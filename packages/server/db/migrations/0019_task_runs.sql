-- 0017_task_runs.sql — Each firing of a task is now its own row, kind='task_run',
-- with parent_id pointing at the task definition. The task message stays as the
-- schedule (cron/executeAt) and never transitions to running/terminal; runs do.
-- Plan: packages/server/docs/plans/task-runs-as-messages.md.

-- Hot path: list a task's runs ordered by start time. Partial index keeps the
-- non-task-run majority of the messages table out of it.
CREATE INDEX IF NOT EXISTS messages_parent_kind_started_idx
  ON messages (parent_id, kind, started_at DESC)
  WHERE kind = 'task_run';

-- Backfill: every existing task with a started_at carries fire-in-place state
-- on the parent row. Materialise that into one task_run child so the run
-- history survives the model change, then reset the parent's execution state
-- so it cleanly represents the schedule. Tasks that have never fired are
-- untouched.
INSERT INTO messages (
  id, chat_id, role, content, parent_id, kind,
  state, started_at, ended_at,
  agent_id, model,
  created_at, updated_at
)
SELECT
  'msg_' || replace(gen_random_uuid()::text, '-', ''),
  m.chat_id,
  m.role,
  m.content,
  m.id,
  'task_run',
  COALESCE(m.state, 'succeeded'),
  m.started_at,
  COALESCE(m.ended_at, m.started_at),
  m.agent_id,
  m.model,
  COALESCE(m.started_at, m.created_at),
  now()
FROM messages m
WHERE m.kind = 'task'
  AND m.started_at IS NOT NULL;

-- For one-shot tasks (executeAt only): the run absorbed the terminal state,
-- so the task definition transitions to a "done" state and clears its
-- per-run timestamps. For cron tasks: clear the per-run timestamps but keep
-- the schedule live by leaving cron in place; the task stays scheduled.
UPDATE messages
   SET state       = CASE
                       WHEN cron IS NOT NULL THEN 'pending'
                       ELSE 'succeeded'
                     END,
       started_at  = NULL,
       ended_at    = NULL
 WHERE kind = 'task'
   AND started_at IS NOT NULL;
