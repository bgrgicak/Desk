-- 0021_library_file_creator.sql — Track the *original* creator of each
-- library file separately from the most-recent author. `agent_id` (added
-- in 0020) reflects whoever last touched the file; `creator_agent_id` is
-- set on first insert and never overwritten, so the Library UI can show
-- a stable "by AI" provenance even after a human edits the file.

ALTER TABLE library_file_authors
  ADD COLUMN creator_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;

-- Backfill: for files we already know about, the only signal we have is
-- the last author. Best approximation for legacy rows.
UPDATE library_file_authors
   SET creator_agent_id = agent_id
 WHERE creator_agent_id IS NULL;
