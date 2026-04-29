-- 0022_library_pins.sql — Sidebar "pinned" library files.
-- SQLite-flavored: TIMESTAMPTZ → TEXT (ISO-8601), now() → strftime(...).

CREATE TABLE library_pins (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  pinned_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (workspace_id, path)
);
