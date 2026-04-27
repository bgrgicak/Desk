-- 0016_user_timezone.sql — IANA timezone (e.g. "America/Los_Angeles")
-- captured from the app client. Self-healing: each authed request carries
-- `X-Client-Timezone`, and the API upserts when the stored value drifts.
-- The scheduler injects it into the agent file so the model interprets
-- unqualified user times in the right zone.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS timezone TEXT;
