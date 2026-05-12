-- 0032_workspace_kinds_and_pins.sql — Hub workspace support.
--
-- Adds a `kind` discriminator on `workspaces` and a generic `pins` table
-- that supports cross-workspace references (used by the hub workspace).
--
-- The kind column drives capability resolution: the API grants different
-- scopes (single-workspace vs. all-owned) based on it. The default is
-- 'project' so every existing row keeps its current behavior. The
-- partial UNIQUE index enforces "at most one hub per user" at the DB
-- level as a backstop — internal code (createHub) is the only path that
-- writes 'hub' today.
--
-- The new `pins` table coexists with `library_pins`. `library_pins`
-- continues to power the per-workspace library "pin a file" toggle;
-- `pins` is the cross-workspace reference layer that the hub uses to
-- pin chats, apps, fragments, library items, and artifacts from any
-- owned workspace into the hub's view.
--
-- ON DELETE CASCADE on both workspace_id and source_workspace_id: a pin
-- evaporates if either end of the reference is removed.

ALTER TABLE workspaces
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'
    CHECK (kind IN ('project', 'hub'));

-- Backstop: at most one hub per user. Internal code is already the only
-- writer of 'hub' (the API rejects user-supplied kinds), so this is a
-- belt-and-suspenders safeguard against direct DB edits.
CREATE UNIQUE INDEX workspaces_user_hub_unique
  ON workspaces (user_id)
  WHERE kind = 'hub';

CREATE TABLE pins (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('chat', 'library_file', 'app', 'fragment', 'artifact')),
  ref_id              TEXT NOT NULL,
  pinned_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (workspace_id, kind, source_workspace_id, ref_id)
);

CREATE INDEX pins_workspace_idx ON pins (workspace_id, pinned_at DESC);
