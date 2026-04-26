-- Sandbox session → workspace.
--
-- Each sandbox container is per-workspace, so every session token is tied
-- to a specific workspace. Tool handlers (file.read, file.write, library.*)
-- look it up to resolve the workspace's on-disk slug and route the call
-- to the right directory.

ALTER TABLE sandbox_sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
