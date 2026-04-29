-- The scheduler_ref column tracked OS at/cron job IDs.
-- Now that we use a DB poll loop, it is unused.
ALTER TABLE messages DROP COLUMN IF EXISTS scheduler_ref;

-- Index for the poll query: pending messages with a due execute_at.
CREATE INDEX IF NOT EXISTS messages_scheduled_poll_idx
  ON messages (execute_at)
  WHERE state = 'pending' AND execute_at IS NOT NULL;
