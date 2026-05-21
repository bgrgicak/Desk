-- 0047_drop_chat_list_running_failed.sql — Stop denormalizing the chat's
-- running/failed flags into `chats.list_running` / `chats.list_failed`.
-- queries/chats.ts now computes them live via subqueries against the
-- latest agent_turn message, and the WS layer ships fresh values on
-- every `chat.updated`, so a denormalized column is just one more
-- representation that can drift from the truth. The matching `list_kind`
-- / `list_internal` denormalization stays — it isn't tied to the
-- sidebar-spinner bug this migration cleans up.

DROP TRIGGER IF EXISTS messages_chat_list_cache_insert;
DROP TRIGGER IF EXISTS messages_chat_list_cache_update;
DROP TRIGGER IF EXISTS messages_chat_list_cache_delete;

ALTER TABLE chats DROP COLUMN list_running;
ALTER TABLE chats DROP COLUMN list_failed;

-- Recreate the triggers, now only maintaining `list_internal` and
-- `list_kind`. The subquery shape mirrors 0038 (created_at DESC,
-- rowid DESC tie-break) so behaviour for the surviving columns is
-- bit-for-bit identical.

CREATE TRIGGER messages_chat_list_cache_insert
AFTER INSERT ON messages
BEGIN
  UPDATE chats
  SET list_internal = CASE
        WHEN json_valid(NEW.content)
          AND json_extract(NEW.content, '$.type') = 'reflection_request'
        THEN 1
        ELSE list_internal
      END,
      list_kind = COALESCE((
        SELECT m.kind
        FROM messages m
        WHERE m.chat_id = NEW.chat_id
          AND m.kind NOT IN ('chat', 'summary', 'reflection')
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT 1
      ), 'chat')
  WHERE id = NEW.chat_id;
END;

CREATE TRIGGER messages_chat_list_cache_update
AFTER UPDATE OF chat_id, content, kind, state, created_at ON messages
BEGIN
  UPDATE chats
  SET list_internal = EXISTS (
        SELECT 1
        FROM messages m
        WHERE m.chat_id = OLD.chat_id
          AND json_valid(m.content)
          AND json_extract(m.content, '$.type') = 'reflection_request'
      ),
      list_kind = COALESCE((
        SELECT m.kind
        FROM messages m
        WHERE m.chat_id = OLD.chat_id
          AND m.kind NOT IN ('chat', 'summary', 'reflection')
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT 1
      ), 'chat')
  WHERE id = OLD.chat_id;

  UPDATE chats
  SET list_internal = EXISTS (
        SELECT 1
        FROM messages m
        WHERE m.chat_id = NEW.chat_id
          AND json_valid(m.content)
          AND json_extract(m.content, '$.type') = 'reflection_request'
      ),
      list_kind = COALESCE((
        SELECT m.kind
        FROM messages m
        WHERE m.chat_id = NEW.chat_id
          AND m.kind NOT IN ('chat', 'summary', 'reflection')
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT 1
      ), 'chat')
  WHERE id = NEW.chat_id AND NEW.chat_id <> OLD.chat_id;
END;

CREATE TRIGGER messages_chat_list_cache_delete
AFTER DELETE ON messages
BEGIN
  UPDATE chats
  SET list_internal = EXISTS (
        SELECT 1
        FROM messages m
        WHERE m.chat_id = OLD.chat_id
          AND json_valid(m.content)
          AND json_extract(m.content, '$.type') = 'reflection_request'
      ),
      list_kind = COALESCE((
        SELECT m.kind
        FROM messages m
        WHERE m.chat_id = OLD.chat_id
          AND m.kind NOT IN ('chat', 'summary', 'reflection')
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT 1
      ), 'chat')
  WHERE id = OLD.chat_id;
END;
