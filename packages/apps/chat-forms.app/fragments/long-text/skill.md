# long-text fragment

Ask the user for a paragraph-length free-text answer.

## Behavior

- Renders the question, a focused multi-line `<textarea>` (6 rows), and a
  Submit button.
- Submit is enabled once the textarea contains non-whitespace text.
- On submit, calls `window.roomy.chat.sendMessage("<typed text>")` and
  disables the form.

## Capabilities

- `chats.write` — required for `window.roomy.chat.sendMessage()`.

## Params

| Param         | Type   | Description                              |
|---------------|--------|------------------------------------------|
| `question`    | string | The question to display.                 |
| `placeholder` | string | Optional placeholder hint inside box.    |

Attach example:

```
roomy-agent chat attach-artifact \
  /opt/roomy-apps/chat-forms.app/dist/fragments/long-text \
  --param question="Describe the bug you ran into" \
  --param placeholder="Steps to reproduce…"
```

## Storage contract

This fragment does not use persistent app storage.

## When to use

Paragraph answers, descriptions, free-form notes. For one-line answers use
`short-text`.
