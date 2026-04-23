-- 0006_drop_execution_tables.sql — Execution state now lives on the messages
-- table (see 0005_messages_execution.sql). The runs / scheduled_jobs /
-- run_events legacy tables are no longer read or written anywhere.

DROP TABLE IF EXISTS run_events;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS scheduled_jobs;
