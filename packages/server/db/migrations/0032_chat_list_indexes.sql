-- Speed up GET /chats sidebar hydration.
-- The chat list derives two per-chat fields from messages: the newest
-- user-action kind and whether the newest agent_turn is still active.
-- These covering indexes let those ranked scans stay ordered by chat.
CREATE INDEX IF NOT EXISTS messages_chat_kind_created_desc_idx
  ON messages (chat_id, kind, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS messages_chat_content_type_created_desc_idx
  ON messages (chat_id, json_extract(content, '$.type'), created_at DESC, id DESC)
  WHERE json_valid(content);
