-- Per-app session tokens (issue #47, PR-C). Each token scopes an iframe
-- to a specific user + chat + app; the server validates the token via the
-- HttpOnly cookie set on the first index.html request.

CREATE TABLE app_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL,                 -- "chat" (PR-E adds "library")
  chat_id      TEXT REFERENCES chats(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_name     TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',    -- JSON array of capability strings
  token_hash   TEXT UNIQUE NOT NULL,
  issued_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE INDEX app_sessions_user_idx ON app_sessions (user_id);
CREATE INDEX app_sessions_chat_idx ON app_sessions (chat_id);
