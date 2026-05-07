-- Add chat-title rows to the canonical search index for databases that
-- already applied 0028 before title indexing existed.

CREATE TRIGGER IF NOT EXISTS chats_ai_chat_search_title
AFTER INSERT ON chats
BEGIN
  INSERT OR REPLACE INTO chat_search_index
    (ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at)
  SELECT
    NEW.id,
    NEW.title,
    LOWER(NEW.title),
    NEW.id,
    (SELECT w.path FROM workspaces w WHERE w.id = NEW.workspace_id),
    'chat',
    NEW.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS chats_au_chat_search_title
AFTER UPDATE OF title, workspace_id, updated_at ON chats
BEGIN
  INSERT OR REPLACE INTO chat_search_index
    (ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at)
  SELECT
    NEW.id,
    NEW.title,
    LOWER(NEW.title),
    NEW.id,
    (SELECT w.path FROM workspaces w WHERE w.id = NEW.workspace_id),
    'chat',
    NEW.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS chats_ad_chat_search_title
AFTER DELETE ON chats
BEGIN
  DELETE FROM chat_search_index
  WHERE kind = 'chat' AND ref_id = OLD.id;
END;

INSERT OR REPLACE INTO chat_search_index
  (ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at)
SELECT
  c.id,
  c.title,
  LOWER(c.title),
  c.id,
  w.path,
  'chat',
  c.updated_at
FROM chats c
JOIN workspaces w ON w.id = c.workspace_id;
