-- Per-workspace on-disk directory.
--
-- Before this migration all workspaces shared a single hardcoded slug
-- ("desk") on disk — two workspaces pointed at the same files. The
-- `path` column stores each workspace's own subdirectory name under
-- `~/Desk/workspaces/{path}/`. It's derived from `name` at create
-- time (slugified, collision-suffixed) and renamed in lock-step when
-- the workspace is renamed.
--
-- Existing rows get backfilled with 'desk' to match the current on-disk
-- state — we don't want to strand the user's already-written files.

ALTER TABLE workspaces ADD COLUMN path TEXT;
UPDATE workspaces SET path = 'desk' WHERE path IS NULL;
ALTER TABLE workspaces ALTER COLUMN path SET NOT NULL;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_path_key UNIQUE (path);
