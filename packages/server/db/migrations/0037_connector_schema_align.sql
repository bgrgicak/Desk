-- Evolves the connector schema introduced in 0036 to its production shape:
--
--   connector_connections:
--     * `capabilities`   → `capabilities_json` (same content; rename for clarity)
--     * + `scopes_json`            -- OAuth scopes granted by the provider
--     * + `metadata_encrypted`     -- provider-specific extras (account email, etc.)
--     * + `credentials_encrypted`  -- OAuth tokens inline; replaces credential_ref
--     * - `credential_ref`         -- pointed at a vault row that no longer exists
--
--   workspace_connector_grants:
--     * + `id`                          -- primary key per grant
--     * + `is_default`                  -- which connection a workspace prefers
--     * + `updated_at`                  -- mutation timestamp
--     * `capabilities` → `granted_capabilities_json`
--     * composite PK (workspace_id, connection_id) → UNIQUE constraint
--
-- credentials_encrypted starts NULL for any existing rows: the prior model
-- stored creds in a separate vault that's being removed in this same feature
-- cycle, so the cleanest path is for users to re-auth through the new flow
-- once. Display-name + provider-id remain so the UI can show "you had a
-- GitHub connection — click to reconnect" rather than dropping the row.

-- ===== connector_connections =====

ALTER TABLE connector_connections RENAME COLUMN capabilities TO capabilities_json;
ALTER TABLE connector_connections ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE connector_connections ADD COLUMN metadata_encrypted BLOB;
ALTER TABLE connector_connections ADD COLUMN credentials_encrypted BLOB;
ALTER TABLE connector_connections DROP COLUMN credential_ref;

-- The new query layer orders by created_at after is_default; the old index
-- with is_default DESC in the middle no longer matches. Swap in the simpler
-- index used by listConnections() and findConnection().
DROP INDEX IF EXISTS connector_connections_owner_provider_idx;
CREATE INDEX IF NOT EXISTS connector_connections_owner_idx
  ON connector_connections(owner_user_id, provider_id, created_at);

-- Rename the one-default-per-provider unique index to match the canonical name
-- used everywhere else in the codebase.
DROP INDEX IF EXISTS connector_connections_one_default_idx;
CREATE UNIQUE INDEX IF NOT EXISTS connector_connections_owner_provider_default_idx
  ON connector_connections(owner_user_id, provider_id)
  WHERE is_default = 1;

-- ===== workspace_connector_grants =====
--
-- SQLite can't drop a PRIMARY KEY in place, can't reorder columns, and can't
-- backfill a NOT NULL primary-key column on an existing table with no source
-- of values. Standard solution: rebuild via a side table, copy data with
-- synthesised ids, swap names. This preserves the (workspace_id, connection_id)
-- pairing as a UNIQUE constraint so existing logic that relied on uniqueness
-- still works.

CREATE TABLE workspace_connector_grants_new (
  id                          TEXT PRIMARY KEY,
  workspace_id                TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id               TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  provider_id                 TEXT NOT NULL,
  granted_capabilities_json   TEXT NOT NULL DEFAULT '[]',
  granted_by_user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_default                  INTEGER NOT NULL DEFAULT 0,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(workspace_id, connection_id)
);

-- Synthesize ids for the rows being carried over. `wcg_` matches
-- ID_PREFIXES.workspaceConnectorGrant in packages/server/shared/src/constants.ts;
-- 15 random bytes → 30 hex chars, well above the nanoid(21) entropy budget
-- generateId() uses for new inserts, so no collisions in practice.
INSERT INTO workspace_connector_grants_new
  (id, workspace_id, connection_id, provider_id, granted_capabilities_json,
   granted_by_user_id, is_default, created_at, updated_at)
SELECT
  'wcg_' || lower(hex(randomblob(15))),
  workspace_id,
  connection_id,
  provider_id,
  capabilities,
  granted_by_user_id,
  0,
  created_at,
  created_at
FROM workspace_connector_grants;

DROP TABLE workspace_connector_grants;
ALTER TABLE workspace_connector_grants_new RENAME TO workspace_connector_grants;

CREATE INDEX IF NOT EXISTS workspace_connector_grants_workspace_idx
  ON workspace_connector_grants(workspace_id, provider_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_connector_grants_workspace_provider_default_idx
  ON workspace_connector_grants(workspace_id, provider_id)
  WHERE is_default = 1;
