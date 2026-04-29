-- 0020_library_file_authors.sql — Track which agent last created or modified
-- each library file so the Desk UI can show real agent names on artifact cards.
-- Populated by the run manager after each agent execution by comparing file
-- mtimes against the run start time.

CREATE TABLE library_file_authors (
  workspace_id  TEXT        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path          TEXT        NOT NULL,
  agent_id      TEXT        REFERENCES agents(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, path)
);

CREATE INDEX library_file_authors_workspace_idx
  ON library_file_authors (workspace_id);
