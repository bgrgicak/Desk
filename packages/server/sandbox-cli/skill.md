# Desk CLI

The `desk` command is your only path to surface work back to the user. It
runs inside the sandbox and POSTs to the host-side desk-server REST API.

## When to use it

You have five commands:
- `desk-agent app create` — clone the Desk app scaffold into a new chat
  artifact directory so you can author a real `<name>.app/`.
- `desk-agent chat attach-artifact` — surface a generated file **or directory**
  as an `artifactRef` card in the current chat.
- `desk-agent file to-markdown` — convert PDFs, DOCX, ODT, RTF, HTML, EPUB,
  LaTeX, and plain text files into agent-readable Markdown/text.
- `desk-agent find library` — discover reusable apps, fragments, notes, and
  docs before building or answering whether a reusable item exists.
- `desk-agent task schedule` — create or schedule Tasks board work.

Reach for them when:

1. **You wrote, updated, or retrieved an artifact the user should see or open.**
   Always call `desk-agent chat attach-artifact --chat <chatId> "<path>"`
   as the last step of any turn in which you create, significantly update, or
   retrieve from the library an artifact. There are no exceptions for type:
   file, app, directory, image, library item, or any other artifact. If the
   artifact is a directory, pass the directory path. Do not reply until the
   attach command has executed or you have determined no attachable
   current-workspace path exists. A library hit from another workspace cannot be
   attached by passing its cross-workspace path directly; copy or update it into
   the current chat/workspace first when possible. If no attachable path exists,
   report that limitation instead of silently skipping or rebuilding.
2. **The user asked for a reminder, recurring report, or follow-up.**
   Schedule a task instead of saying "I'll remember to do that" — you
   won't.
3. **A piece of work needs to live on the user's Tasks board.** Manual
   tasks (no `--at`/`--cron`) sit there until the user runs them.
4. **You need to fire your own future turn.** A scheduled task with
   `--at` or `--cron` re-enters the chat at fire time with your `<content>`
   as the prompt.

5. **You need to read a document attachment that is not already text.** Run
   `desk-agent file to-markdown "<path>"` before summarizing, extracting, or
   transforming its contents. Use `--output <path>.md` when you need to inspect
   or reuse the converted text across steps.

6. **The user wants you to build an app.** Run
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

Clone the Desk app scaffold into a chat artifact directory for the
current chat. This section documents the command contract only; the app
architecture, fragment model, and test/build workflow live in the
`desk-app-scaffold` skill that is copied into the generated app.

```
desk-agent app create --chat <id> [--template <path>] <name>
```

`<name>` must be kebab-case: lowercase letters, digits, and dashes,
starting with a letter. The new directory lands at
`~/.chats/<chatId>/artifacts/<name>.app/`. Refuses to clobber an
existing directory at that path.

After scaffolding, load the `desk-app-scaffold` skill from the generated
app before editing files.

### Examples

```
desk-agent app create --chat cht_abc my-todos
```

## desk-agent chat attach-artifact

Create an `artifactRef` message in the chat for an existing file or directory.
Always use this as the last step of any turn in which you create,
significantly update, or retrieve from the library an artifact before replying
to the user. Only pass paths that exist in the current chat/workspace; a
cross-workspace library hit must be copied or updated into the current
chat/workspace before attachment when possible. If the command fails or no
attachable current-workspace path exists, report the limitation inline instead
of silently skipping.

```
desk-agent chat attach-artifact --chat <id> [--name <text>] <workspace-relative-path>
```

`<workspace-relative-path>` is the workspace-relative path to any artifact type
under `.chats/<chatId>/artifacts/`: file, app, directory, image, or another
artifact. Directories are valid paths.
Strip the leading `~/`: `~/.chats/cht_abc/artifacts/report.md` becomes
`.chats/cht_abc/artifacts/report.md`.

For `.app/` directories, pass the **directory** path — not a file inside it.
The chat will render the app inline as an interactive iframe.

### Examples

Attach a file:
```
desk-agent chat attach-artifact --chat cht_abc \
    .chats/cht_abc/artifacts/report.md
```

Attach a `.app/` directory (renders as an interactive app in chat):
```
desk-agent chat attach-artifact --chat cht_abc \
    .chats/cht_abc/artifacts/my-todos.app
```

Attach with a custom display name:
```
desk-agent chat attach-artifact --chat cht_abc \
    --name "Weekly report" \
    .chats/cht_abc/artifacts/report.md
```

Attach a parameterized fragment:
```
desk-agent chat attach-artifact --chat cht_abc \
    --param note_id=abc-123 --param mode=edit \
    notes.app/dist/fragments/note-editor
```

## desk-agent chat search-messages

Full-text search the user's chat history. Use when the user references
something that happened "before", "in another chat", "last week", etc., or
when you need to recall a fact from earlier in this same chat that landed
before the most recent summary.

```
desk-agent chat search-messages --query <text> [--chat <id>]
                                [--workspace <current-slug>]
                                [--kind any|message|summary]
                                [--limit N]
```

`--query` is whitespace-tokenized; every token must appear in the indexed
body. Wrap multi-word phrases in quotes at the shell level. Recall is scoped to
the current sandbox session workspace. Do not use “other chats” as a reason to
search other workspaces; cross-workspace recall is not available yet.
`--workspace` is only an optional assertion for the current workspace slug.
`--kind summary` returns only chat-summary bodies; `--kind message` returns only
raw transcript lines.

The response is a JSON object `{hits: [...]}`. Each hit has `chatId`,
`messageId`, `workspaceSlug`, `kind`, a `snippet` with `<mark>…</mark>`
highlights, `createdAt`, and a relevance `score`.

### Examples

```
desk-agent chat search-messages --query "kanban board"
desk-agent chat search-messages --query "deploy notes" --kind summary
desk-agent chat search-messages --query "passwords"
```

## desk-agent find library

Discover reusable apps, fragments, notes, and docs in the user's library. Use
this before building something new. If a returned library item satisfies the
task, attach it with `desk-agent chat attach-artifact` in the same turn instead
of creating a duplicate. Do not scaffold or rebuild an app, fragment, note, doc,
or artifact when a suitable library item already exists unless the user
explicitly asks for a new one. Only pass a hit's `path` directly when the item
is in the current chat/workspace; cross-workspace hits need a current-workspace
copy or another attachable path before `chat attach-artifact` can surface them.

```
desk-agent find library [--query <text>] [--kind app|fragment|note|doc|any]
                        [--workspace <slug>|*] [--limit N]
```

When `--query` is omitted, the command returns recent library items. App and
fragment hits may include `params_schema`; pass concrete values with repeated
`--param key=value` flags when attaching a fragment.

### Examples

```
desk-agent find library --query "note editor" --kind fragment
desk-agent find library --query "todos"
desk-agent find library --kind app
```

## desk-agent file to-markdown

Convert a document to agent-readable Markdown/text. Use this before analyzing
uploaded office documents, PDFs, ebooks, or HTML when raw file contents are not
directly readable.

```
desk-agent file to-markdown [--output <path>] <workspace-relative-path>
```

Supported formats:
- `.pdf` through `pdftotext -layout`
- `.docx`, `.odt`, `.rtf`, `.html`, `.htm`, `.epub`, `.tex`, `.rst` through `pandoc`
- `.md`, `.markdown`, `.txt`, `.csv`, `.tsv`, `.json`, `.xml`, `.yaml`, `.yml` as already-readable text

This is text extraction/conversion, not OCR. Scanned PDFs and image-only pages
need a separate OCR workflow.

### Examples

Convert a PDF to stdout:
```
desk-agent file to-markdown Reports/Q1.pdf
```

Write a DOCX conversion to a reusable Markdown file:
```
desk-agent file to-markdown --output Reports/Q1.md Reports/Q1.docx
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
