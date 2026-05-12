-- Provider API keys are now stored in the per-user KDBX vault, not the DB.
-- Existing instances lose access to their stored keys on upgrade; they
-- will need to re-enter them after setting up and unlocking their vault.
ALTER TABLE user_settings DROP COLUMN provider_keys_encrypted;
