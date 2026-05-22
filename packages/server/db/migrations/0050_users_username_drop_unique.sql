-- Drop the UNIQUE constraint on users.username.
--
-- The login identifier is now `email` (already UNIQUE), and `username`
-- has been demoted to a free-form display name that the agent uses to
-- address the user. Two different users can share the same display
-- name, so the column-level UNIQUE has to go.
--
-- SQLite has no DROP CONSTRAINT, so we follow the standard recreate-
-- and-swap dance. `defer_foreign_keys = ON` postpones FK enforcement
-- until COMMIT so the DROP TABLE / RENAME doesn't trip rows in
-- agents/workspaces/chats/etc. that reference users(id).
PRAGMA defer_foreign_keys = ON;

CREATE TABLE users_new (
  id                   TEXT PRIMARY KEY,
  username             TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  email                TEXT UNIQUE NOT NULL,
  avatar_path          TEXT,
  timezone             TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  must_change_password INTEGER NOT NULL DEFAULT 0
);

INSERT INTO users_new (
  id, username, password_hash, email, avatar_path, timezone, created_at, must_change_password
)
SELECT
  id, username, password_hash, email, avatar_path, timezone, created_at, must_change_password
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
