-- Per-message provenance + attachments.
--
-- `model` records which model produced an agent message. Stamped at insert
-- time so history survives agent reconfiguration; null on user/system rows.
--
-- `attachments` carries file references attached to a single message — the
-- "user sent these files alongside their text" case. JSONB array of
-- {path, name, mime?, size?}. Stored on the envelope, not inside content,
-- so MessageContent stays a single-shape discriminated union.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS model       TEXT,
  ADD COLUMN IF NOT EXISTS attachments JSONB;
