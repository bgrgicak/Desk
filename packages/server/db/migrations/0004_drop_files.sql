-- 0004_drop_files.sql — Files are tracked on the filesystem only. Drop the
-- DB shadow index (and its pg_trgm GIN index).

DROP INDEX IF EXISTS idx_files_name_trgm;
DROP INDEX IF EXISTS idx_files_workspace_class_created;
DROP TABLE IF EXISTS files;
