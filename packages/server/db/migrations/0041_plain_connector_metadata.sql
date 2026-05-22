-- Secrets now live exclusively in the per-user KDBX vault. The remaining
-- connection/user-settings metadata is non-secret JSON, so drop the old
-- ROOMY_SECRET_KEY-backed encrypted blobs and store plain JSON instead.
-- Existing encrypted metadata is intentionally not migrated.

ALTER TABLE connector_connections ADD COLUMN metadata_json TEXT;
ALTER TABLE connector_connections DROP COLUMN metadata_encrypted;

ALTER TABLE user_settings ADD COLUMN provider_meta_json TEXT;
ALTER TABLE user_settings DROP COLUMN provider_meta_encrypted;
