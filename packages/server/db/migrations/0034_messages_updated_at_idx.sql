-- Indexes for the idle-sandbox sweep (`sweepIdleSandboxes` in scheduler/runs.ts),
-- which runs once a minute and asks "which workspaces had any message activity
-- in the last 30 min, or any running rows right now?". Without these, every
-- sweep scans the entire `messages` table — fine for fresh installs, painful
-- at 100k+ messages.
CREATE INDEX IF NOT EXISTS messages_updated_at_idx
  ON messages (updated_at);

-- Partial index on running messages. Running rows are sparse (bounded by
-- concurrent fires) so the index stays tiny, but it turns the `state='running'`
-- arm of the sweep from a full-table scan into a constant-time lookup.
CREATE INDEX IF NOT EXISTS messages_running_idx
  ON messages (chat_id)
  WHERE state = 'running';
