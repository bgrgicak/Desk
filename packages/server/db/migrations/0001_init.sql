-- 0001_init.sql — Initial SQLite schema. Flattened from the 19-step
-- Postgres migration history; no data migration carries over.
--
-- Type translations from the Postgres origin:
--   JSONB         → TEXT  (with optional CHECK (json_valid(...)) where
--                          the column is always a JSON document)
--   TIMESTAMPTZ   → TEXT  (ISO 8601 UTC strings, e.g. 2026-04-28T08:00:00.000Z)
--   BOOLEAN       → INTEGER (0/1)
--   BYTEA         → BLOB
--   TEXT[]        → TEXT (JSON array)
--   BIGSERIAL     → INTEGER PRIMARY KEY AUTOINCREMENT
--   gen_random_uuid() — generated app-side via crypto.randomUUID()
--
-- Default `now()` becomes `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` to
-- preserve the JS Date.toISOString() format and ms precision.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  avatar_path   TEXT,
  timezone      TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE agents (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  model        TEXT NOT NULL DEFAULT 'opencode/big-pickle'
);

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '',
  path        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE workspace_agents (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL REFERENCES agents(id)     ON DELETE CASCADE,
  added_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (workspace_id, agent_id)
);

CREATE TABLE chats (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL REFERENCES agents(id)     ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT '',
  goal          TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  awaiting_user INTEGER NOT NULL DEFAULT 0,
  unread        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_chats_workspace_updated ON chats (workspace_id, updated_at DESC);

CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL,                                   -- JSON
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Execution / scheduling metadata (formerly the runs/scheduled_jobs tables).
  execute_at    TEXT,
  cron          TEXT,
  state         TEXT,
  parent_id     TEXT REFERENCES messages(id) ON DELETE SET NULL,
  agent_id      TEXT REFERENCES agents(id)   ON DELETE SET NULL,
  started_at    TEXT,
  ended_at      TEXT,
  -- Provenance / payload extensions.
  model         TEXT,
  attachments   TEXT,                                            -- JSON array
  -- Discriminator: 'chat' | 'task' | 'task_run' | 'summary' …
  kind          TEXT NOT NULL DEFAULT 'chat',
  title         TEXT
);

CREATE INDEX idx_messages_chat_created
  ON messages (chat_id, created_at);

-- Pending scheduled work the reconciler walks on boot.
CREATE INDEX messages_pending_scheduled_idx
  ON messages (execute_at)
  WHERE execute_at IS NOT NULL AND state = 'pending';

CREATE INDEX messages_chat_state_idx
  ON messages (chat_id, state);

-- Tasks page listing: surfaces every kind that's not a plain chat message.
CREATE INDEX messages_kind_created_idx
  ON messages (kind, created_at DESC)
  WHERE kind <> 'chat';

-- Hot path: list a task's runs ordered by start time.
CREATE INDEX messages_parent_kind_started_idx
  ON messages (parent_id, kind, started_at DESC)
  WHERE kind = 'task_run';

CREATE TABLE sandbox_sessions (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash   TEXT UNIQUE NOT NULL,
  issued_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at   TEXT
);

CREATE TABLE user_settings (
  user_id                 TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider_keys_encrypted BLOB,
  provider_meta_encrypted BLOB,
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE provider_key_access_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action     TEXT NOT NULL CHECK (action IN ('read', 'write', 'delete')),
  providers  TEXT NOT NULL DEFAULT '[]',                         -- JSON array
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX provider_key_access_log_user_id_idx
  ON provider_key_access_log (user_id, created_at DESC);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX auth_sessions_user_idx
  ON auth_sessions (user_id);
