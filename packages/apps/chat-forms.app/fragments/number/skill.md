# number fragment

Ask the user for a numeric answer.

## Behavior

- Renders the question, a focused `<input type="number">`, and a Submit button.
- Submit is enabled once the input parses to a finite number.
- On submit, calls `window.roomy.chat.sendMessage("<number>")` and disables the
  form.

## Capabilities

- `chats.write` — required for `window.roomy.chat.sendMessage()`.

## Params

| Param      | Type   | Description                              |
|------------|--------|------------------------------------------|
| `question` | string | The question to display.                 |
| `min`      | number | Minimum allowed value.                   |
| `max`      | number | Maximum allowed value.                   |

Attach example:

```
roomy-agent chat attach-artifact \
  /opt/roomy-apps/chat-forms.app/dist/fragments/number \
  --param question="How many people are coming?" \
  --param min=1 \
  --param max=20
```

## Storage contract

This fragment does not use persistent app storage.

## When to use

Quantity / count / numeric measurement questions. For a 1..N satisfaction
score with a UI affordance, use `rating` instead.
