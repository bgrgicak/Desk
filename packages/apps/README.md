# @roomy-ai/apps

Roomy-shipped built-in apps. Each `*.app/` directory in this package is a complete Roomy app — the same structure that `roomy-agent app create` produces in a workspace — pre-built so `dist/` is shipped alongside source.

On server start, `runtime.writeBuiltinApps(home)` copies every `<name>.app/` here into `~/Roomy/.apps/<name>.app/` (overwriting), then the sandbox mount plan binds `~/Roomy/.apps/` read-only at `/opt/roomy-apps/`. Agents attach built-in fragments via the regular `roomy-agent chat attach-artifact` command using paths under `/opt/roomy-apps/`.

## Adding a built-in app

The intended workflow is to build the app via Roomy itself (dogfood), then promote the workspace output into this package:

1. Open a Roomy chat in any workspace.
2. Ask Roomy to build the app (e.g. `chat-forms.app` with a `yes_no` fragment).
3. Iterate until the workspace app is correct.
4. Copy `<workspace>/.chats/<chatId>/artifacts/<name>.app/` into `packages/apps/<name>.app/`.
5. Commit. The next server start syncs it into `~/Roomy/.apps/`.

## Constraint

All built-in apps must use `@roomy-ai/ui` for every UI primitive — no raw HTML elements where a UI component exists, no second component library. If a primitive is missing, add it to `@roomy-ai/ui` first.
