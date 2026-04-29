-- Index for the DB-poll scheduler query: pending messages with a due
-- execute_at. The poll loop scans this index every tick to claim work,
-- so it pays for itself even on small-to-medium message tables.
CREATE INDEX IF NOT EXISTS messages_scheduled_poll_idx
  ON messages (execute_at)
  WHERE state = 'pending' AND execute_at IS NOT NULL;
