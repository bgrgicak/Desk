-- Add `created_at` to chats.
--
-- SQLite refuses non-constant DEFAULTs in ALTER TABLE ADD COLUMN
-- (`strftime(...)` and other expressions are forbidden — see
-- https://sqlite.org/lang_altertable.html#altertabaddcol).  Three
-- steps so the migration is byte-identical regardless of whether the
-- table is empty or already has data:
--
--   1. Add the column with an empty-string default so the ADD COLUMN
--      succeeds even on populated databases.  Every pre-existing row
--      lands at `created_at = ''` after this statement.
--   2. Backfill from `updated_at`: every chat row had `updated_at`
--      stamped on insert (table default), so it's the closest proxy
--      we have to the original create time.
--   3. Future inserts must set `created_at` explicitly — see the
--      INSERT statement in `packages/server/db/src/queries/chats.ts`
--      which now writes `strftime(...)` directly.
ALTER TABLE chats ADD COLUMN created_at TEXT NOT NULL DEFAULT '';

UPDATE chats SET created_at = updated_at WHERE created_at = '';
