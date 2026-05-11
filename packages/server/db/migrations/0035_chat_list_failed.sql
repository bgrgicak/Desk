-- Cache whether a chat's latest agent turn failed so the sidebar can render
-- retryable failures distinctly from normal unread/new-message dots.

ALTER TABLE chats ADD COLUMN list_failed INTEGER NOT NULL DEFAULT 0;

UPDATE chats
SET list_failed = COALESCE((
  SELECT m.state = 'failed'
  FROM messages m
  WHERE m.chat_id = chats.id
    AND json_valid(m.content)
    AND json_extract(m.content, '$.type') = 'agent_turn'
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1
), 0);

DROP TRIGGER IF EXISTS messages_chat_list_cache_insert;
DROP TRIGGER IF EXISTS messages_chat_list_cache_update;
DROP TRIGGER IF EXISTS messages_chat_list_cache_delete;

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
      ), 0),
      list_failed = COALESCE((
        SELECT m.state = 'failed'
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
      ), 0),
      list_failed = COALESCE((
        SELECT m.state = 'failed'
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
      ), 0),
      list_failed = COALESCE((
        SELECT m.state = 'failed'
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
      ), 0),
      list_failed = COALESCE((
        SELECT m.state = 'failed'
        FROM messages m
        WHERE m.chat_id = OLD.chat_id
          AND json_valid(m.content)
          AND json_extract(m.content, '$.type') = 'agent_turn'
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ), 0)
  WHERE id = OLD.chat_id;
END;
