-- 0003_workspace_agents.sql — Agents are user-owned; workspace_agents lists
-- which agents are enabled in each workspace and which one is the default.

ALTER TABLE agents ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;

-- Prototype phase: attach every existing agent to the first user. In prod
-- this would be a real migration; in dev the DB is nuked-and-reseeded.
UPDATE agents SET user_id = (SELECT id FROM users ORDER BY created_at LIMIT 1)
  WHERE user_id IS NULL;

ALTER TABLE agents ALTER COLUMN user_id SET NOT NULL;

CREATE TABLE workspace_agents (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, agent_id)
);

-- Exactly one default agent per workspace.
CREATE UNIQUE INDEX workspace_agents_one_default
  ON workspace_agents (workspace_id)
  WHERE is_default;

-- Seed: every existing agent is enabled in every existing workspace; the
-- first agent (by name) is the default.
INSERT INTO workspace_agents (workspace_id, agent_id, is_default)
SELECT w.id, a.id,
       (a.id = (SELECT id FROM agents ORDER BY name LIMIT 1))
FROM workspaces w CROSS JOIN agents a;
