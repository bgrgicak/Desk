-- Per-Desk-chat opencode-serve session.
--
-- Each chat owns one long-lived opencode session that turns are appended
-- to. Threads are themselves chats (see 0036), so each thread gets its
-- own session naturally — no special-casing.
--
-- Nullable: the session is created lazily on the first turn after this
-- migration runs. Existing chats keep behaving (re-)allocate-on-first-fire
-- once the new runtime is deployed.
ALTER TABLE chats
  ADD COLUMN opencode_session_id TEXT;
