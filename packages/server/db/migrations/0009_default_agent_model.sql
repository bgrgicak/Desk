-- Default model for freshly-inserted agents.
--
-- opencode/big-pickle is the house default — opencode's zero-config model
-- that requires no provider key, so a user can start chatting without
-- touching Preferences. Existing agent rows are left alone; only future
-- INSERTs that omit `model` pick up the new default.

ALTER TABLE agents ALTER COLUMN model SET DEFAULT 'opencode/big-pickle';
