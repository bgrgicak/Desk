# @roomy-ai/app-scaffold

Template tree for an agent-authored Roomy app.

This package isn't published or imported. It's baked into the sandbox
image at `/opt/roomy-template/app/` (with `node_modules/` pre-installed)
and copied into a chat artifact directory on demand by
`roomy-agent app create <name>`. Every Roomy app starts as a copy of this
tree.

For agent-facing instructions see `AGENTS.md` in this directory.

The structure is documented in
`packages/server/docs/plans/2026-04-30-chat-apps-design.md`.
