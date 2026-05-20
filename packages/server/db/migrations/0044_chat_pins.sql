-- 0044_chat_pins.sql — Sidebar "pinned" chats, sibling to library_pins.
-- SQLite-flavored: TIMESTAMPTZ → TEXT (ISO-8601), now() → strftime(...).

CREATE TABLE chat_pins (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_id       TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  pinned_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (workspace_id, chat_id)
);
