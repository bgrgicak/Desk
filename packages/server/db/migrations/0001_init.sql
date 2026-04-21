-- 0001_init.sql — Create all v1 tables, indexes, and pg_trgm GIN indexes.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  username    TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  email       TEXT UNIQUE NOT NULL,
  avatar_path TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  instructions    TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  tool_allowlist  JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chats (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT '',
  goal          TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  awaiting_user BOOLEAN NOT NULL DEFAULT false,
  unread        BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE files (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_id      TEXT REFERENCES chats(id) ON DELETE SET NULL,
  class        TEXT NOT NULL,
  path         TEXT NOT NULL,
  name         TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id               TEXT PRIMARY KEY,
  chat_id          TEXT REFERENCES chats(id) ON DELETE SET NULL,
  scheduled_job_id TEXT,
  state            TEXT NOT NULL DEFAULT 'pending',
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  exit_code        INTEGER,
  log_path         TEXT
);

CREATE TABLE run_events (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scheduled_jobs (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT REFERENCES chats(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  spec        JSONB NOT NULL,
  at_job_id   TEXT,
  crontab_id  TEXT,
  next_run_at TIMESTAMPTZ,
  active      BOOLEAN NOT NULL DEFAULT true
);

-- FK from runs.scheduled_job_id added after scheduled_jobs is created.
-- Use SET NULL so a run's record survives if its originating job is deleted.
ALTER TABLE runs
  ADD CONSTRAINT fk_runs_scheduled_job
  FOREIGN KEY (scheduled_job_id) REFERENCES scheduled_jobs(id) ON DELETE SET NULL;

CREATE TABLE sandbox_sessions (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  issued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

-- Composite indexes for common queries
CREATE INDEX idx_chats_workspace_updated ON chats (workspace_id, updated_at DESC);
CREATE INDEX idx_messages_chat_created ON messages (chat_id, created_at);
CREATE INDEX idx_files_workspace_class_created ON files (workspace_id, class, created_at DESC);
CREATE INDEX idx_run_events_run_seq ON run_events (run_id, seq);

-- pg_trgm GIN indexes for fuzzy search
CREATE INDEX idx_files_name_trgm ON files USING GIN (name gin_trgm_ops);
CREATE INDEX idx_chats_title_trgm ON chats USING GIN (title gin_trgm_ops);
CREATE INDEX idx_messages_content_text_trgm ON messages USING GIN ((content->>'text') gin_trgm_ops);
