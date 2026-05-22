ALTER TABLE agents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE agents
SET sort_order = COALESCE((
  SELECT COUNT(*)
  FROM agents earlier
  WHERE earlier.user_id = agents.user_id
    AND (
      earlier.name < agents.name
      OR (earlier.name = agents.name AND earlier.id < agents.id)
    )
), 0);
