-- Index covering the chat-list "lastMessage" preview subquery.
--
-- `listWithLatestMessage` (db/queries/chats.ts) runs a correlated
-- subquery against the newest user/agent text message per chat:
--
--   SELECT json_extract(m.content, '$.text')
--   FROM messages m
--   WHERE m.chat_id = c.id
--     AND m.role IN ('user', 'agent')
--     AND json_valid(m.content)
--     AND json_extract(m.content, '$.type') = 'text'
--   ORDER BY m.created_at DESC, m.id DESC
--   LIMIT 1
--
-- The existing `messages_chat_content_type_created_desc_idx` covers
-- (chat_id, type, created_at DESC, id DESC) but leaves `role` as a
-- residual filter — so on chats whose most recent text rows are
-- system-authored, SQLite walks the index until it finds a user/
-- agent row.  This partial index narrows the seek to only the rows
-- the subquery can actually pick, keeping the preview O(log N) per
-- chat regardless of how much system traffic the chat carries.
CREATE INDEX IF NOT EXISTS messages_chat_text_user_agent_idx
  ON messages (chat_id, created_at DESC, id DESC)
  WHERE json_valid(content)
    AND json_extract(content, '$.type') = 'text'
    AND role IN ('user', 'agent');
