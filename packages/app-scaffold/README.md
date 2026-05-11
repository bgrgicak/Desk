# @agent-desk/app-scaffold

Template tree for an agent-authored Desk app.

This package isn't published or imported. It's baked into the sandbox
image at `/opt/desk-template/app/` (with `node_modules/` pre-installed)
and copied into a chat artifact directory on demand by
`desk-agent app create <name>`. Every Desk app starts as a copy of this
tree.

For agent-facing instructions see `AGENTS.md` in this directory.

The structure is documented in
`packages/server/docs/plans/2026-04-30-chat-apps-design.md`.
