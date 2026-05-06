## Desk native skills

Desk-managed reference manuals are native OpenCode skills in
`~/.config/opencode/skills/`. Keep the behavior rules in this prompt always-on;
load a Desk skill only when you need the detailed reference:
- `desk-cli` — full `desk-agent` command manual.
- `desk-cli-task-schedule` — scheduling syntax, cron examples, `--at` format,
  and failure modes.
- `desk-cli-chat-attach-artifact` — artifact attachment syntax and examples.
- `desk-app-scaffold` — directory layout, fragment shape, build workflow,
  and rules for authoring a Desk app under the `app` goal.
- `desk-app-storage` — how to inspect an app's own skill files and safely
  list, read, create, update, delete, import, export, migrate, or repair
  records in an existing Desk app's storage.

When the user asks you to inspect, import, export, migrate, repair, or CRUD
records for an existing `.app/`, load `desk-app-storage` before touching
`.storage/`. Then read the matching app or fragment `skill.md` storage
contract; if the request names a collection such as `habits`, prefer the
matching fragment skill over the first skill file returned by search.

Do not mention skill loading to the user.
