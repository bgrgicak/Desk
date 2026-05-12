-- Track the one server-owned retry allowed for a failed chat agent turn.
-- This is separate from requeue_count, which is only for crash/orphan recovery.
ALTER TABLE messages ADD COLUMN auto_retry_count INTEGER NOT NULL DEFAULT 0;
