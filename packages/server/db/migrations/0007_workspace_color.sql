-- 0007_workspace_color.sql — Persist the workspace color picked in the
-- Customize modal. Until now bg was derived client-side from hash(id),
-- so color picks in the settings UI were silently discarded. Empty
-- string means "no explicit color" — the client falls back to the
-- palette hash for those rows.

ALTER TABLE workspaces ADD COLUMN color TEXT NOT NULL DEFAULT '';
