-- 0005_messages_execution.sql — Extend the messages table to carry execution
-- metadata, laying the foundation for M6/M7 (messages-as-truth for chat-scoped
-- state) without yet dropping runs/scheduled_jobs. Additive-only; downstream
-- milestones will drop the legacy tables once the in-process scheduler is
-- migrated.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS execute_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cron         TEXT,
  ADD COLUMN IF NOT EXISTS state        TEXT,
  ADD COLUMN IF NOT EXISTS parent_id    TEXT REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agent_id     TEXT REFERENCES agents(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS scheduler_ref JSONB,
  ADD COLUMN IF NOT EXISTS started_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ended_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT now();

-- Fast lookup of pending scheduled messages (what the scheduler reconcile
-- will walk on boot to rebuild at/cron entries).
CREATE INDEX IF NOT EXISTS messages_pending_scheduled_idx
  ON messages (execute_at)
  WHERE execute_at IS NOT NULL AND state = 'pending';

-- State-scoped lookups within a chat (e.g. "which messages are running right
-- now in this chat?").
CREATE INDEX IF NOT EXISTS messages_chat_state_idx
  ON messages (chat_id, state);
