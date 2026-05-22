-- Rename `chats.opencode_session_id` to `chats.pi_session_id`.
--
-- The column was named after the old opencode-serve runtime (0040). The
-- runtime is pi now, and the column's value is a pi session id, so the
-- name was misleading. No data change — same nullable TEXT column.
ALTER TABLE chats
  RENAME COLUMN opencode_session_id TO pi_session_id;
