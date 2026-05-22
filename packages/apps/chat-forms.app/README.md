# chat-forms.app

Built-in Roomy app. Provides fragments that agents attach to a chat message
instead of asking the user a question in plain text. The user sees a small
UI (buttons, radio list, checkboxes, text field, date picker, star rating,
or a multi-step wizard) and their reply comes back as a normal chat message
via the `chats.write` capability.

Synced into `~/Roomy/.apps/chat-forms.app/` on server start by
`runtime.writeBuiltinApps()`, then mounted read-only at
`/opt/roomy-apps/chat-forms.app/` inside every sandbox.

## Fragments

| Fragment        | Question shape                                     |
|-----------------|----------------------------------------------------|
| `yes-no`        | Binary yes / no.                                   |
| `single-choice` | Pick exactly one of N options.                     |
| `multi-select`  | Select any subset of N options.                    |
| `short-text`    | Single-line free-text answer.                      |
| `long-text`     | Paragraph-length free-text answer.                 |
| `number`        | Numeric answer (with optional min/max).            |
| `date`          | Calendar date (`YYYY-MM-DD`).                      |
| `rating`        | 1..N star rating (default 5).                      |
| `multi-step`    | Wizard combining any of the above into one turn.   |

Each fragment ships its agent-facing instructions in `fragments/<name>/skill.md`.

## Attach examples

```
# Single question:
roomy-agent chat attach-artifact \
  /opt/roomy-apps/chat-forms.app/dist/fragments/yes-no \
  --param question="Delete the draft?"

# Multi-step wizard (one chat message in, one consolidated answer out):
roomy-agent chat attach-artifact \
  /opt/roomy-apps/chat-forms.app/dist/fragments/multi-step \
  --param steps='[
    {"type":"short-text","question":"What is the project called?"},
    {"type":"single-choice","question":"What kind?","options":["plugin","theme","site"]},
    {"type":"date","question":"Ship date?"},
    {"type":"yes-no","question":"Scaffold a starter repo?"}
  ]'
```

## Architecture

All fragments share a single `Wizard` component (`src/wizard/Wizard.tsx`)
that owns navigation, validation, and chat-bridge submission. Each fragment
is a thin wrapper that reads its URL params, builds a `Step[]`, and hands
them to the Wizard. The multi-step fragment accepts a JSON-encoded array;
the single-question fragments synthesize a one-step array. Adding a new
question type means:

1. Add a variant to `Step` in `src/wizard/types.ts`.
2. Add an `<XInput>` controlled component in `src/wizard/inputs/`.
3. Add a `case` to the dispatcher in `src/wizard/Wizard.tsx`.
4. Add a `case` to `isAnswered` / `defaultValue` in
   `src/wizard/validation.ts` (and `formatSingle` in `format.ts` if it needs
   special rendering).
5. Drop a `fragments/<name>/` directory with the canonical five files.
6. Register the name in `roomy.app.json` and rebuild.

## Build

```
npm run build       # produces dist/ (root SPA + per-fragment standalone entries)
npm run typecheck
npm run test
npm run verify      # build + typecheck + test + structural sanity checks
```
