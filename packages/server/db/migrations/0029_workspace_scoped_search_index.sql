-- Memory-system Phase 4 fixup: library index rows use workspace-relative
-- paths as ref_id, so the workspace slug must participate in the key.
-- Chat rows already carry workspace_slug and keep the same effective
-- uniqueness because message ids are globally unique.

DROP TRIGGER IF EXISTS messages_ai_chat_search;
DROP TRIGGER IF EXISTS messages_au_chat_search;
DROP TRIGGER IF EXISTS messages_ad_chat_search;

CREATE TABLE chat_search_index_next (
  ref_id          TEXT NOT NULL,
  body            TEXT NOT NULL,
  body_lc         TEXT NOT NULL,
  chat_id         TEXT,
  workspace_slug  TEXT,
  kind            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (kind, workspace_slug, ref_id)
);

INSERT OR REPLACE INTO chat_search_index_next
  (ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at)
SELECT ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at
FROM chat_search_index;

DROP TABLE chat_search_index;
ALTER TABLE chat_search_index_next RENAME TO chat_search_index;

CREATE INDEX chat_search_workspace_idx ON chat_search_index (workspace_slug);
CREATE INDEX chat_search_chat_idx      ON chat_search_index (chat_id);
CREATE INDEX chat_search_kind_idx      ON chat_search_index (kind);

CREATE TRIGGER messages_ai_chat_search
AFTER INSERT ON messages
WHEN
  json_valid(NEW.content)
  AND json_extract(NEW.content, '$.type') IN ('text', 'summary')
BEGIN
  INSERT OR REPLACE INTO chat_search_index
    (ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at)
  SELECT
    NEW.id,
    COALESCE(json_extract(NEW.content, '$.text'), json_extract(NEW.content, '$.body'), ''),
    LOWER(COALESCE(json_extract(NEW.content, '$.text'), json_extract(NEW.content, '$.body'), '')),
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
    COALESCE(json_extract(NEW.content, '$.text'), json_extract(NEW.content, '$.body'), ''),
    LOWER(COALESCE(json_extract(NEW.content, '$.text'), json_extract(NEW.content, '$.body'), '')),
    NEW.chat_id,
    (SELECT w.path FROM chats c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = NEW.chat_id),
    CASE WHEN json_extract(NEW.content, '$.type') = 'summary' THEN 'summary' ELSE 'message' END,
    NEW.created_at
  WHERE
    json_valid(NEW.content)
    AND json_extract(NEW.content, '$.type') IN ('text', 'summary');
END;

CREATE TRIGGER messages_ad_chat_search
AFTER DELETE ON messages
BEGIN
  DELETE FROM chat_search_index
  WHERE ref_id = OLD.id AND kind IN ('message', 'summary');
END;
