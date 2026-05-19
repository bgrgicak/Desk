-- First-run safety flag on users.must_change_password.
--
-- A fresh `desk-server` install seeds a user with the documented
-- DESK_SEED_PASSWORD (default "change-me-before-first-boot"). When the
-- operator never sets DESK_SEED_PASSWORD, that account ships with a
-- known-public password — the seed routine now sets this flag so the
-- SPA can prompt the user to change it before doing anything else.
--
-- Cleared by `POST /me/password` after a successful change.
-- Surfaced on `GET /me` so the SPA can react without polling a
-- separate endpoint.
--
-- Existing rows default to 0 — only first-boot installs that use the
-- documented seed credential set the flag.
ALTER TABLE users
  ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
