# short-text fragment

Ask the user for a single-line free-text answer.

## Behavior

- Renders the question, a focused single-line `<input type="text">`, and a
  Submit button.
- Submit is enabled once the input contains non-whitespace text.
- On submit, calls `window.desk.chat.sendMessage("<typed text>")` and
  disables the form.

## Capabilities

- `chats.write` — required for `window.desk.chat.sendMessage()`.

## Params

| Param         | Type   | Description                              |
|---------------|--------|------------------------------------------|
| `question`    | string | The question to display.                 |
| `placeholder` | string | Optional placeholder hint inside input.  |

Attach example:

```
desk-agent chat attach-artifact \
  /opt/desk-apps/chat-forms.app/dist/fragments/short-text \
  --param question="What should I call you?" \
  --param placeholder="First name"
```

## Storage contract

This fragment does not use persistent app storage.

## When to use

Short identifiers, names, single phrases. For multi-line / paragraph input
use `long-text`. For numbers use `number`, dates use `date`.
