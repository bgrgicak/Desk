-- 0002_user_settings.sql — Per-user settings with encrypted provider keys.

CREATE TABLE user_settings (
  user_id                   TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider_keys_encrypted   BYTEA,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
