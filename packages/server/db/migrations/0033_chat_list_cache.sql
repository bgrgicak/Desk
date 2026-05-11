-- Cache chat-list derived fields on chats so GET /chats can stay a single
-- indexed list read. The values are still maintained from messages, but that
-- work happens incrementally on writes instead of being recomputed for every
-- visible chat on every sidebar load.

ALTER TABLE chats ADD COLUMN list_kind TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE chats ADD COLUMN list_running INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN list_internal INTEGER NOT NULL DEFAULT 0;

UPDATE chats
SET list_internal = EXISTS (
  SELECT 1
  FROM messages m
  WHERE m.chat_id = chats.id
    AND json_valid(m.content)
    AND json_extract(m.content, '$.type') = 'reflection_request'
);

UPDATE chats
SET list_kind = COALESCE((
  SELECT m.kind
  FROM messages m
  WHERE m.chat_id = chats.id
    AND m.kind NOT IN ('chat', 'summary', 'reflection')
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1
), 'chat');

UPDATE chats
SET list_running = COALESCE((
  SELECT m.state IN ('pending', 'running')
  FROM messages m
  WHERE m.chat_id = chats.id
    AND json_valid(m.content)
    AND json_extract(m.content, '$.type') = 'agent_turn'
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1
), 0);

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
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ), 'chat'),
      list_running = COALESCE((
        SELECT m.state IN ('pending', 'running')
        FROM messages m
        WHERE m.chat_id = NEW.chat_id
          AND json_valid(m.content)
          AND json_extract(m.content, '$.type') = 'agent_turn'
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ), 0)
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
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ), 'chat'),
      list_running = COALESCE((
        SELECT m.state IN ('pending', 'running')
        FROM messages m
        WHERE m.chat_id = OLD.chat_id
          AND json_valid(m.content)
          AND json_extract(m.content, '$.type') = 'agent_turn'
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ), 0)
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
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ), 'chat'),
      list_running = COALESCE((
        SELECT m.state IN ('pending', 'running')
        FROM messages m
        WHERE m.chat_id = NEW.chat_id
          AND json_valid(m.content)
          AND json_extract(m.content, '$.type') = 'agent_turn'
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ), 0)
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
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ), 'chat'),
      list_running = COALESCE((
        SELECT m.state IN ('pending', 'running')
        FROM messages m
        WHERE m.chat_id = OLD.chat_id
          AND json_valid(m.content)
          AND json_extract(m.content, '$.type') = 'agent_turn'
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ), 0)
  WHERE id = OLD.chat_id;
END;

CREATE INDEX IF NOT EXISTS idx_chats_workspace_list_internal_updated
  ON chats (workspace_id, list_internal, updated_at DESC);
