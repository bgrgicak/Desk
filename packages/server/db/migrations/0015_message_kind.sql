-- 0013_message_kind.sql — Introduce a `kind` discriminator on messages so that
-- "user-defined task" can be a first-class message kind alongside ordinary
-- chat messages and system mechanisms like ai-note refresh triggers. Plan:
-- packages/server/docs/plans/message-as-task.md.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS kind  TEXT NOT NULL DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS title TEXT;

-- Backfill ai_note_request rows so the scheduler and listing filters can
-- dispatch on `kind` from this point forward. The content type marker stays
-- in place during the transition; the fire handler will prefer kind.
UPDATE messages
   SET kind = 'ai_note'
 WHERE kind = 'chat'
   AND content->>'type' = 'ai_note_request';

-- Tasks page listing: `kind <> 'chat'` matches every kind that surfaces on a
-- non-chat surface (tasks, ai_note today, more later). Partial index keeps
-- the chat-message majority out of the index.
CREATE INDEX IF NOT EXISTS messages_kind_created_idx
  ON messages (kind, created_at DESC)
  WHERE kind <> 'chat';
