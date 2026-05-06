-- Memory-system Phase 3, P3.1 + P3.2 + P3.3.
--
-- Search index over chat messages and chat-summary bodies. The spec
-- targets SQLite FTS5, but Node 23's bundled SQLite (3.49.1) is
-- compiled without FTS5 support — `PRAGMA compile_options` lists no
-- ENABLE_FTS5 and `CREATE VIRTUAL TABLE … USING fts5(…)` raises
-- "no such module: fts5". Until Node ships an FTS5-enabled build (or
-- we add a native dep, which the project policy forbids) we back the
-- index with a regular table and `LIKE` queries.
--
-- The denormalized columns (`chat_id`, `workspace_slug`, `kind`) and
-- the trigger surface match the FTS5 design exactly — swapping to
-- FTS5 later is a single migration that re-creates the table and
-- backfills, with no query-layer change beyond the snippet/score
-- functions.
--
-- Phase 4 (P4.3) extends this same table to cover library content
-- (apps, fragments, notes, docs).

CREATE TABLE chat_search_index (
  -- For chat content this is the message id; for Phase-4 library
  -- content it's the workspace-relative path.
  ref_id          TEXT NOT NULL,
  body            TEXT NOT NULL,
  body_lc         TEXT NOT NULL,           -- lowercased copy for case-insensitive LIKE
  chat_id         TEXT,                    -- NULL for library content
  workspace_slug  TEXT,
  -- 'message' | 'summary' | (Phase 4) 'note' | 'doc' | 'app' | 'fragment'
  kind            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (kind, ref_id)
);

CREATE INDEX chat_search_workspace_idx ON chat_search_index (workspace_slug);
CREATE INDEX chat_search_chat_idx      ON chat_search_index (chat_id);
CREATE INDEX chat_search_kind_idx      ON chat_search_index (kind);

-- INSERT trigger: index new chat-message rows whose JSON content is
-- type='text' or type='summary'. Other types (events, toolCall,
-- artifactRef, etc.) are skipped — they're either internal plumbing or
-- structured data without a user-meaningful body.
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
    COALESCE(
      json_extract(NEW.content, '$.text'),
      json_extract(NEW.content, '$.body'),
      ''
    ),
    LOWER(COALESCE(
      json_extract(NEW.content, '$.text'),
      json_extract(NEW.content, '$.body'),
      ''
    )),
    NEW.chat_id,
    (SELECT w.path FROM chats c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = NEW.chat_id),
    CASE WHEN json_extract(NEW.content, '$.type') = 'summary' THEN 'summary' ELSE 'message' END,
    NEW.created_at;
END;

-- UPDATE trigger: re-index. Cheapest correct path is "drop the prior
-- row by (kind, ref_id), re-insert if still indexable" — sidesteps a
-- prior-vs-new content-type matrix.
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
      ''
    ),
    LOWER(COALESCE(
      json_extract(NEW.content, '$.text'),
      json_extract(NEW.content, '$.body'),
      ''
    )),
    NEW.chat_id,
    (SELECT w.path FROM chats c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = NEW.chat_id),
    CASE WHEN json_extract(NEW.content, '$.type') = 'summary' THEN 'summary' ELSE 'message' END,
    NEW.created_at
  WHERE
    json_valid(NEW.content)
    AND json_extract(NEW.content, '$.type') IN ('text', 'summary');
END;

-- DELETE trigger: drop from the index.
CREATE TRIGGER messages_ad_chat_search
AFTER DELETE ON messages
BEGIN
  DELETE FROM chat_search_index
  WHERE ref_id = OLD.id AND kind IN ('message', 'summary');
END;

-- P3.3 — Backfill all eligible message rows into the index. Runs once
-- during this migration; future inserts/updates/deletes flow through
-- the triggers above.
INSERT OR REPLACE INTO chat_search_index
  (ref_id, body, body_lc, chat_id, workspace_slug, kind, created_at)
SELECT
  m.id,
  COALESCE(
    json_extract(m.content, '$.text'),
    json_extract(m.content, '$.body'),
    ''
  ),
  LOWER(COALESCE(
    json_extract(m.content, '$.text'),
    json_extract(m.content, '$.body'),
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
  AND json_extract(m.content, '$.type') IN ('text', 'summary');
