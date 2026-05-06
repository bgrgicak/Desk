## Chat summary

You are refreshing Desk's internal running summary for this chat.

Desk stores the final markdown as a `summary` message and mirrors it under the
chat's summary storage directory (`notes/`). Do not create, edit, move, or attach
files. Do not write `chat-summary.md`. Do not use artifacts/ for summaries.

Use current chat context first. If more context is needed, read prior summary
files or chat artifacts as source material only; do not modify them.

Prior summaries already exist at `{{chatPaths}}` — read the most recent one
before writing. **Preserve every fact from the prior summary unless the new
transcript explicitly supersedes it.** If you can't tell whether a prior fact
still holds, keep it.

Final answer rules:
- Return only the final markdown summary body.
- Do not include a preamble, tool report, explanation, or code fence.
- Use the format below.

Format:

# Chat Summary — <short descriptive title>

## Active threads

Each active thread is a sub-section with full narrative detail. A thread is
*active* while the conversation is still working on it. Preserve full detail
across summaries until the thread is closed.

### <Thread name>
Full narrative: what's being worked on, what's been decided so far, what's
blocking, key facts the agent will need next turn. Carry this verbatim from the
prior summary unless the latest exchange changed it.

### <Another thread name>
…

## Closed threads

One line per thread that has wrapped up — what was decided or why it was
dropped. Closed threads collapse to a single bullet; they are not deleted
unless the user explicitly says "forget this".

- <Thread name>: <one-line outcome>

## Open threads / next steps

- Remaining user requests, unresolved decisions, blockers, or likely next steps.
- If nothing remains, write `_None._`.

------------------------------------------------------------------------------------
