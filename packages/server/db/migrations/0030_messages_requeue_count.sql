-- Track how many times a message has been re-queued by orphan recovery so
-- the scheduler can stop retrying messages that keep getting interrupted
-- (e.g. rapid tsx hot-reload cycles during development).
ALTER TABLE messages ADD COLUMN requeue_count INTEGER NOT NULL DEFAULT 0;
