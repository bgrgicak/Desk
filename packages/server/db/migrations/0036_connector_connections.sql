-- Initial connector tables. Schema evolved in 0037 to support inline encrypted
-- credentials, scopes/capabilities as separate JSON blobs, encrypted metadata,
-- and per-grant ids with is_default. Kept at this earlier shape here because
-- it matches what already-applied dev DBs ran against — the alignment is
-- 0037's job, not a retroactive edit to this file.

CREATE TABLE IF NOT EXISTS connector_connections (
  id             TEXT PRIMARY KEY,
  provider_id    TEXT NOT NULL,
  owner_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_account_id TEXT,
  display_name   TEXT NOT NULL,
  capabilities   TEXT NOT NULL DEFAULT '[]',
  credential_ref TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'disabled', 'revoked', 'error')),
  is_default     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS connector_connections_owner_provider_idx
  ON connector_connections (owner_user_id, provider_id, is_default DESC, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS connector_connections_one_default_idx
  ON connector_connections (owner_user_id, provider_id)
  WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS workspace_connector_grants (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id   TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  provider_id     TEXT NOT NULL,
  capabilities    TEXT NOT NULL DEFAULT '[]',
  granted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (workspace_id, connection_id)
);

CREATE INDEX IF NOT EXISTS workspace_connector_grants_workspace_provider_idx
  ON workspace_connector_grants (workspace_id, provider_id);

CREATE INDEX IF NOT EXISTS workspace_connector_grants_connection_idx
  ON workspace_connector_grants (connection_id);
