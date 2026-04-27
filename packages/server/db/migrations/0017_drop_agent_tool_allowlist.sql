-- 0015_drop_agent_tool_allowlist.sql — The sandbox tool socket and the seven
-- per-tool RPC handlers (file.read, library.list, chat.send_message, …) are
-- gone. The agent now talks to the host through one CLI command —
-- `desk task schedule` — that POSTs to a single REST endpoint authenticated
-- by a sandbox session token. With no per-tool dispatch left, the agent's
-- per-tool allowlist column has nothing to gate.

ALTER TABLE agents
  DROP COLUMN IF EXISTS tool_allowlist;
