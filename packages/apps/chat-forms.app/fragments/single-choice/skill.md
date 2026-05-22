# single-choice fragment

Ask the user to pick exactly one option from a list via radio buttons.

## Behavior

- Renders the question, a vertical list of radio options, and a Submit button.
- Submit is enabled once an option is selected.
- On submit, calls `window.roomy.chat.sendMessage("<selected option>")` and
  disables the form.

## Capabilities

- `chats.write` — required for `window.roomy.chat.sendMessage()`.

## Params

| Param      | Type   | Description                                                          |
|------------|--------|----------------------------------------------------------------------|
| `question` | string | The question to display.                                             |
| `options`  | string | Comma-separated labels (e.g. `red,green,blue`) or a JSON array.      |

Attach example:

```
roomy-agent chat attach-artifact \
  /opt/roomy-apps/chat-forms.app/dist/fragments/single-choice \
  --param question="Pick a color" \
  --param options="red,green,blue"
```

## Storage contract

This fragment does not use persistent app storage.

## When to use

Single-best-answer choices (status, priority, category). For binary yes/no
use the `yes-no` fragment; for "select all that apply" use `multi-select`.
