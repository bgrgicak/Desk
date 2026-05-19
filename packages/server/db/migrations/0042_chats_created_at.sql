-- Add `created_at` to chats.  Pre-existing rows backfill from
-- `updated_at` (the closest proxy we have — every chat row had its
-- updated_at set on insert) so the API can serve `createdAt` for every
-- chat without distinguishing pre- vs. post-migration data.
ALTER TABLE chats ADD COLUMN created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE chats SET created_at = updated_at WHERE created_at IS NULL OR created_at = '';
