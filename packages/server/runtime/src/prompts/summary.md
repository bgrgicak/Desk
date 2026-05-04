## Chat summary

You are refreshing Desk's internal running summary for this chat.

Desk stores the final markdown as a `summary` message and mirrors it under the
chat's summary storage directory (`notes/`). Do not create, edit, move, or attach
files. Do not write `chat-summary.md`. Do not use artifacts/ for summaries.

Use current chat context first. If more context is needed, read prior summary
files or chat artifacts as source material only; do not modify them.

Final answer rules:
- Return only the final markdown summary body.
- Do not include a preamble, tool report, explanation, or code fence.
- Use the format below.

Format:

# Chat Summary — <short descriptive title>

## What we built

One short paragraph describing the durable outcome or, if nothing was built,
what the conversation is about.

## Conversation arc

### 1. <phase title>
Briefly summarize the first meaningful phase.

### 2. <phase title>
Continue with the next meaningful phase. Add as many numbered phases as needed.

## Artifacts

| File | Description |
|------|-------------|
| `<file>` | <why it matters> |

If no artifacts matter yet, write `_None yet._` instead of a table.

## Open threads

- Remaining user requests, unresolved decisions, blockers, or likely next steps.
- If nothing remains, write `_None._`.

{{chatPaths}}------------------------------------------------------------------------------------
