-- Threads: a thread is a normal chat anchored to one parent message.
-- The parent message stays canonical; `thread_chat_id` on the parent row
-- points at the chat that holds the thread transcript.

ALTER TABLE messages
  ADD COLUMN thread_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL;

-- One parent message can have at most one thread chat.
CREATE UNIQUE INDEX messages_thread_chat_id_unique
  ON messages(thread_chat_id)
  WHERE thread_chat_id IS NOT NULL;
