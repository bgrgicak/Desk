-- 0014_provider_meta.sql — Per-user provider metadata (display names etc.)
-- Stored as encrypted JSON alongside the existing provider_keys_encrypted.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS provider_meta_encrypted BYTEA;
