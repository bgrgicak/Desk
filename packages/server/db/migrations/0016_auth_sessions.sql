-- 0014_auth_sessions.sql — Persist user-session tokens so a server restart no
-- longer wipes every active login. The previous in-memory Map gave a confusing
-- "Invalid or expired session token" UX whenever the dev server hot-reloaded
-- mid-session even though the browser's stored token was still in its TTL.
--
-- The table holds only the SHA-256 hash of each token (never the raw token),
-- mirroring sandbox_sessions. issued_at + a single index let verifySession
-- enforce the 7-day TTL without scanning.

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
  ON auth_sessions (user_id);
