-- Memory system, P1.5. The per-agent `instructions` field is collapsed
-- into the per-user `~/Desk/.memory/memory.md` file injected on every
-- turn. Drop the column; existing values are not migrated automatically
-- (the prototype's only deployments are dev machines; surviving content
-- can be moved manually before this migration applies).
ALTER TABLE agents DROP COLUMN instructions;
