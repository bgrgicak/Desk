# @agent-desk/desk-apps

Desk-shipped built-in apps. Each `*.app/` directory in this package is a complete Desk app — the same structure that `desk-agent app create` produces in a workspace — pre-built so `dist/` is shipped alongside source.

On server start, `runtime.writeBuiltinApps(home)` copies every `<name>.app/` here into `~/Desk/.apps/<name>.app/` (overwriting), then the sandbox mount plan binds `~/Desk/.apps/` read-only at `/opt/desk-apps/`. Agents attach built-in fragments via the regular `desk-agent chat attach-artifact` command using paths under `/opt/desk-apps/`.

## Adding a built-in app

The intended workflow is to build the app via DESK itself (dogfood), then promote the workspace output into this package:

1. Open a Desk chat in any workspace.
2. Ask DESK to build the app (e.g. `chat-forms.app` with a `yes_no` fragment).
3. Iterate until the workspace app is correct.
4. Copy `<workspace>/.chats/<chatId>/artifacts/<name>.app/` into `packages/desk-apps/<name>.app/`.
5. Commit. The next server start syncs it into `~/Desk/.apps/`.

## Constraint

All built-in apps must use `@agent-desk/ui` for every UI primitive — no raw HTML elements where a UI component exists, no second component library. If a primitive is missing, add it to `@agent-desk/ui` first.
