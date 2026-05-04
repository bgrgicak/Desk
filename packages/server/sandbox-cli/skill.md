# Desk CLI

The `desk` command is your only path to surface work back to the user. It
runs inside the sandbox and POSTs to the host-side desk-server REST API.

## When to use it

You have three commands:
- `desk-agent app create` — clone the Desk app scaffold into a new chat
  artifact directory so you can author a real `<name>.app/`.
- `desk-agent chat attach-artifact` — surface a generated file as an
  `artifactRef` card in the current chat.
- `desk-agent task schedule` — create or schedule Tasks board work.

Reach for them when:

1. **You wrote an artifact the user should see or open.**
   Call `desk-agent chat attach-artifact` after saving the file so the chat
   receives an `artifactRef` message instead of only inline text.
2. **The user asked for a reminder, recurring report, or follow-up.**
   Schedule a task instead of saying "I'll remember to do that" — you
   won't.
3. **A piece of work needs to live on the user's Tasks board.** Manual
   tasks (no `--at`/`--cron`) sit there until the user runs them.
4. **You need to fire your own future turn.** A scheduled task with
   `--at` or `--cron` re-enters the chat at fire time with your `<content>`
   as the prompt.

5. **The user wants you to build an app.** Run
   `desk-agent app create <name> --chat <chatId>` to scaffold a new
   `<name>.app/` chat artifact, then load the `desk-app-scaffold`
   skill for the development workflow.

If you just need to reply to the user *now*, write to stdout — that's the
chat reply channel. Don't use `desk-agent task schedule` for plain replies.

## How to use it (action bias)

Run the command first, narrate after. Don't ask the user to confirm
defaults you can fill in (date, title, timezone). The instructions in the
agent file specify the defaults — apply them silently and tell the user
what you did in one short sentence.

Anti-pattern (do not do this):
> "I can schedule that. Which timezone? One-time or recurring? Want a title?
>  Plan: …. Confirm and I'll run it."

Pattern (do this):
> *runs* `desk-agent task schedule --chat … --at "2026-04-27T18:51:00Z" "Hello there"`
> *replies* "Scheduled for today at 20:51 Europe/Berlin — 'Hello there'."

## Environment

The runtime sets these for you. Don't echo, log, or alter them.
- `DESK_SANDBOX_TOKEN` — per-run auth token sent as `X-Desk-Sandbox-Token`.
- `DESK_API_URL`       — base URL of the host desk-server.

## Output format

- Success: JSON message row on stdout, exit 0.
- Failure: JSON `{"code": "...", "message": "..."}` on stderr, non-zero exit.

## desk-agent app create

Clone the Desk app scaffold into a chat artifact directory so you can
build an app for the current chat. The scaffold lives at
`/opt/desk-template/app` inside the sandbox, with `node_modules/`
already installed, so the new `<name>.app/` is ready for `npm run build`
without any network access.

```
desk-agent app create --chat <id> [--template <path>] <name>
```

`<name>` must be kebab-case: lowercase letters, digits, and dashes,
starting with a letter. The new directory lands at
`~/.chats/<chatId>/artifacts/<name>.app/`. Refuses to clobber an
existing directory at that path.

After scaffolding, load the `desk-app-scaffold` skill for the development
rules (static-only, capability bridge, fragment shape, etc.) and
follow them.

### Examples

```
desk-agent app create --chat cht_abc my-todos
```

After it returns:

```
cd ~/.chats/cht_abc/artifacts/my-todos.app
npm run build
desk-agent chat attach-artifact --chat cht_abc \
    .chats/cht_abc/artifacts/my-todos.app
```

## desk-agent chat attach-artifact

Create an `artifactRef` message in the chat for an existing file. Use this after
writing a new artifact or making a significant visible update.

```
desk-agent chat attach-artifact --chat <id> [--name <text>] <workspace-relative-path>
```

`<workspace-relative-path>` is usually a file under `.chats/<chatId>/artifacts/`.
Strip the leading `~/`: `~/.chats/cht_abc/artifacts/report.md` becomes
`.chats/cht_abc/artifacts/report.md`.

### Examples

```
desk-agent chat attach-artifact --chat cht_abc \
    .chats/cht_abc/artifacts/report.md
```

```
desk-agent chat attach-artifact --chat cht_abc \
    --name "Weekly report" \
    .chats/cht_abc/artifacts/report.md
```

## desk-agent task schedule

Create a task message in a chat. The task can be:
- **Scheduled** (`--at <iso8601>`): fires once at the given instant.
- **Recurring** (`--cron <expr>`): fires on each cron tick.
- **Manual** (neither): sits as a TODO on the Tasks board.

```
desk-agent task schedule --chat <id> [--title <text>] [--at <iso> | --cron <expr>] [--kind <kind>] <content>
```

`--at` and `--cron` are mutually exclusive. If you pass both, the command
errors out — pick one.

### Examples

Recurring — weekday standup reminder at 09:00:

```
desk-agent task schedule --chat ch_abc \
    --title "Daily standup" \
    --cron "0 9 * * 1-5" \
    "Post the standup template to #team-engineering"
```

One-shot — fires once at a specific time:

```
desk-agent task schedule --chat ch_abc \
    --title "Review migration PR" \
    --at "2026-05-01T15:00:00Z" \
    "Review the schema migration PR before the merge freeze"
```

Manual — no schedule, sits on the Tasks board until the user runs it:

```
desk-agent task schedule --chat ch_abc \
    --title "Summarize Q1 metrics" \
    "Pull the Q1 numbers from the deck and produce a 1-pager"
```

### Cron quick reference

Classic 5-field crontab: `minute hour day-of-month month day-of-week`.

```
0 9 * * 1-5       weekdays at 09:00
*/15 * * * *      every 15 minutes
0 */2 * * *       every 2 hours, on the hour
0 0 1 * *         midnight on the 1st of each month
0 17 * * 5        Fridays at 17:00
```

Day-of-week: 0 (Sun) – 6 (Sat). Avoid sub-minute cadences — the task
fires through the system `at`/`cron` daemon, not a sub-second loop.

### --at format

ISO 8601 with timezone. Both forms are accepted:
- `2026-05-01T09:00:00Z`         (UTC)
- `2026-05-01T09:00:00-07:00`    (offset)

Past timestamps fire immediately on insert. Don't pass timezone-naive
strings — the parser will reject them.

### --kind

Defaults to `task`. Override only if you have a reason — the other kinds
(`summary`, `chat`) drive specialized internal flows that don't behave
like user-visible tasks.

### Failure modes worth knowing

- `NO_TOKEN` / `NO_ENDPOINT` — the runtime didn't inject env. Surface to
  the user; you can't recover.
- `UNAUTHORIZED` — your token expired (run was canceled and re-issued).
  Don't retry; the next turn will mint a fresh one.
- `NOT_FOUND` on chatId — the chat doesn't belong to your agent's user.
  Double-check the id you're using.
- `VALIDATION` — bad `--at` or `--cron`. Read the message and fix the
  argument; don't paper over it with a different schedule.
