-- 0012_drop_workspace_agents_default.sql — Remove the per-workspace default-
-- agent concept. The app falls back to the first enrolled agent by `added_at`
-- (see workspaceAgents.listForWorkspace), which is enough now that every chat
-- binds its own agent.

DROP INDEX IF EXISTS workspace_agents_one_default;
ALTER TABLE workspace_agents DROP COLUMN IF EXISTS is_default;
