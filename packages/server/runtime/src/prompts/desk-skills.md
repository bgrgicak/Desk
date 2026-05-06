## Desk native skills

Desk-managed reference manuals are native OpenCode skills in
`~/.config/opencode/skills/`. Keep the behavior rules in this prompt always-on;
load a Desk skill only when you need the detailed reference:
- `desk-cli` — full `desk-agent` command manual.
- `desk-cli-task-schedule` — scheduling syntax, cron examples, `--at` format,
  and failure modes.
- `desk-cli-chat-attach-artifact` — artifact attachment syntax and examples.
- `desk-cli-file-to-markdown` — document conversion syntax, supported formats,
  and examples.
- `desk-app-scaffold` — directory layout, fragment shape, build workflow,
  and rules for authoring a Desk app under the `app` goal.

The sandbox has Firefox, Playwright, Xvfb, the `playwright` MCP server,
`pandoc`, and `pdftotext` pre-wired. Use the Playwright MCP tools for rendered
pages, screenshots, DOM inspection, and browser automation; assume Firefox
unless the workspace installs another browser. Use `desk-agent file to-markdown`
before analyzing PDFs or office documents whose raw contents are not directly
readable.

Do not mention skill loading to the user.
