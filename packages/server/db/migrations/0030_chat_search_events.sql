-- Index persisted agent event logs so global search can find AI replies.

DROP TRIGGER IF EXISTS messages_ai_chat_search;
DROP TRIGGER IF EXISTS messages_au_chat_search;

CREATE TRIGGER messages_ai_chat_search
AFTER INSERT ON messages
WHEN
  json_valid(NEW.content)
  AND json_extract(NEW.content, '$.type') IN ('text', 'summary', 'events')
BEGIN
  INSERT OR REPLACE INTO chat_search_index
    (ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at)
  SELECT
    NEW.id,
    COALESCE(
      json_extract(NEW.content, '$.text'),
      json_extract(NEW.content, '$.body'),
      (SELECT group_concat(COALESCE(
        json_extract(value, '$.event.part.text'),
        json_extract(value, '$.line'),
        ''
      ), '') FROM json_each(NEW.content, '$.log')),
      ''
    ),
    LOWER(COALESCE(
      json_extract(NEW.content, '$.text'),
      json_extract(NEW.content, '$.body'),
      (SELECT group_concat(COALESCE(
        json_extract(value, '$.event.part.text'),
        json_extract(value, '$.line'),
        ''
      ), '') FROM json_each(NEW.content, '$.log')),
      ''
    )),
    NEW.chat_id,
    (SELECT w.path FROM chats c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = NEW.chat_id),
    CASE WHEN json_extract(NEW.content, '$.type') = 'summary' THEN 'summary' ELSE 'message' END,
    NEW.created_at;
END;

CREATE TRIGGER messages_au_chat_search
AFTER UPDATE ON messages
BEGIN
  DELETE FROM chat_search_index
  WHERE ref_id = NEW.id AND kind IN ('message', 'summary');

  INSERT INTO chat_search_index
    (ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at)
  SELECT
    NEW.id,
    COALESCE(
      json_extract(NEW.content, '$.text'),
      json_extract(NEW.content, '$.body'),
      (SELECT group_concat(COALESCE(
        json_extract(value, '$.event.part.text'),
        json_extract(value, '$.line'),
        ''
      ), '') FROM json_each(NEW.content, '$.log')),
      ''
    ),
    LOWER(COALESCE(
      json_extract(NEW.content, '$.text'),
      json_extract(NEW.content, '$.body'),
      (SELECT group_concat(COALESCE(
        json_extract(value, '$.event.part.text'),
        json_extract(value, '$.line'),
        ''
      ), '') FROM json_each(NEW.content, '$.log')),
      ''
    )),
    NEW.chat_id,
    (SELECT w.path FROM chats c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = NEW.chat_id),
    CASE WHEN json_extract(NEW.content, '$.type') = 'summary' THEN 'summary' ELSE 'message' END,
    NEW.created_at
  WHERE
    json_valid(NEW.content)
    AND json_extract(NEW.content, '$.type') IN ('text', 'summary', 'events');
END;

INSERT OR REPLACE INTO chat_search_index
  (ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at)
SELECT
  m.id,
  COALESCE(
    json_extract(m.content, '$.text'),
    json_extract(m.content, '$.body'),
    (SELECT group_concat(COALESCE(
      json_extract(value, '$.event.part.text'),
      json_extract(value, '$.line'),
      ''
    ), '') FROM json_each(m.content, '$.log')),
    ''
  ),
  LOWER(COALESCE(
    json_extract(m.content, '$.text'),
    json_extract(m.content, '$.body'),
    (SELECT group_concat(COALESCE(
      json_extract(value, '$.event.part.text'),
      json_extract(value, '$.line'),
      ''
    ), '') FROM json_each(m.content, '$.log')),
    ''
  )),
  m.chat_id,
  w.path,
  CASE WHEN json_extract(m.content, '$.type') = 'summary' THEN 'summary' ELSE 'message' END,
  m.created_at
FROM messages m
JOIN chats c ON c.id = m.chat_id
JOIN workspaces w ON w.id = c.workspace_id
WHERE
  json_valid(m.content)
  AND json_extract(m.content, '$.type') IN ('text', 'summary', 'events');
