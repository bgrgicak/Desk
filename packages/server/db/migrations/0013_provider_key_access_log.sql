CREATE TABLE provider_key_access_log (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     TEXT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action      TEXT         NOT NULL CHECK (action IN ('read', 'write', 'delete')),
  providers   TEXT[]       NOT NULL DEFAULT '{}',
  reason      TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX provider_key_access_log_user_id_idx
  ON provider_key_access_log (user_id, created_at DESC);
