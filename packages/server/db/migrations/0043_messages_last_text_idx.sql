-- Index covering the chat-list "lastMessage" preview subquery.
--
-- `listWithLatestMessage` (db/queries/chats.ts) runs a correlated
-- subquery against the newest visible user/agent message per chat:
--
--   SELECT m.content
--   FROM messages m
--   WHERE m.chat_id = c.id
--     AND m.role IN ('user', 'agent')
--     AND json_valid(m.content)
--     AND json_extract(m.content, '$.type') IN ('text', 'events')
--   ORDER BY m.created_at DESC, m.id DESC
--   LIMIT 1
--
-- (Original agent text replies are stored as `type='events'` with a
-- log array — only direct user prompts are `type='text'`, so the
-- subquery filter has to cover both.)
--
-- The existing `messages_chat_content_type_created_desc_idx` covers
-- (chat_id, type, created_at DESC, id DESC) but leaves `role` as a
-- residual and only narrows by a single type at a time.  This
-- partial index narrows the seek to exactly the rows the subquery
-- can return, keeping the preview O(log N) per chat regardless of
-- how much system / tool traffic the chat carries.
CREATE INDEX IF NOT EXISTS messages_chat_text_user_agent_idx
  ON messages (chat_id, created_at DESC, id DESC)
  WHERE json_valid(content)
    AND json_extract(content, '$.type') IN ('text', 'events')
    AND role IN ('user', 'agent');
