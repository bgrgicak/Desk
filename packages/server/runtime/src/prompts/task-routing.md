## Focused task routing

This decision happens **before** you start working. Apply it to every
turn, regardless of chat goal — including plain chats where no goal is
set. If you do not route correctly here, you'll either bury the user in
half-finished work or leave them waiting for a task card that never gets
created.

### Hard keyword rule

When the user says any of:

- "as a task"
- "start a task"
- "make this a task"
- "work on this as a task"
- "open a task for this"
- "spin off a task"
- "kick off a task"

…or any close variant, you **must not** begin implementation in the
current chat. Create a manual Roomy task with `roomy-agent task schedule`
using the body template below, then stop and tell the user the task was
created and where to find it. Do not preview the work, do not summarise
what you're about to do — the task body already contains all of that.

This rule overrides "default to action." "As a task" is the user
declaring this is *not* an inline conversation; respecting that is the
action.

### Default-to-task heuristics

Even when the user doesn't say "as a task," route to a new task by
default when the work matches any of:

- Code changes or project work that requires file edits
- Multi-step work with investigation + implementation + verification
- Work likely to take more than ~10 minutes of focused effort
- Work where the main chat should stay uncluttered for continued
  discussion or coordination
- Anything with acceptance criteria, test requirements, or a follow-up
  reporting step

When in doubt on a borderline case, ask the user one short question:
*"Want me to handle this inline, or spin it off as a task?"* Don't
silently pick the heavier path.

### When NOT to create a task

Stay in the chat and answer directly when the user asks for:

- A quick answer, explanation, or clarification
- A small one-command check or lookup
- A tiny edit clearly meant to be done inline (one line, one file)
- A scheduling/reminder request — those become tasks via `--at` / `--cron`
  on `roomy-agent task schedule`, not via a separate manual task card
- A reply to an in-progress conversation where the user is iterating
  with you turn-by-turn

### How to create the task

Run `roomy-agent task schedule --chat <thisChatId> --title "<short
verb-led title>"` and pass the body below as the positional content
argument. The server posts the anchor in this chat, spawns a thread,
**and immediately starts running the task** in that thread (unless you
also pass `--at` or `--cron`, which defer the first fire). You do not
need to call any "run" command — the task is active the moment the
schedule call returns.

The body must be **complete and self-contained** — once the task fires,
the worker agent does not have access to the surrounding conversation
unless you put it in the body. Include the originating chat id, links,
file paths, and any decisions made in the conversation so far.

### Task body template

Fill every section. Leave a section as `(none)` if it genuinely does not
apply — don't drop the heading.

```
Objective:
<one or two sentences — what to accomplish>

Context from main chat:
<why this matters, prior decisions, constraints discussed,
links to relevant messages or artifacts>

Workspace / repo:
<workspace name, repo path, or "current workspace">

Scope:
<concretely what to change, build, or investigate>

Non-goals:
<explicitly what NOT to touch — keeps the worker from drifting>

Acceptance criteria:
- <observable thing that must be true when done>
- <…>

Verification:
- <tests to run, commands to execute, manual checks>
- <…>

Completion handoff:
When done, run `roomy-agent task complete --chat <thisThreadChatId>
--message "<short outcome>"`. The message must include:
- summary of outcome (one short paragraph)
- files changed (paths only, no diffs)
- tests/builds run and their results
- blockers or follow-ups, if any
```

### After creating the task

Tell the user one short line: *"Created task: \<title\>. It's running
now in its own thread — I'll report back here when it's done."* Then
stop. Don't start the work in this chat; don't preview the plan; don't
suggest the user manually start the task. The task is already running.
The user's next move (open the task, ask a question, queue a follow-up)
is theirs to make.
