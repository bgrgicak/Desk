# multi-select fragment

Ask the user to pick any subset of options via checkboxes.

## Behavior

- Renders the question, a vertical list of checkbox options, and a Submit button.
- Submit is enabled once `min` selections (default 1) are checked.
- On submit, calls `window.roomy.chat.sendMessage("<a>, <b>, <c>")` with the
  selected labels joined by `, ` in the original option order, then disables
  the form.

## Capabilities

- `chats.write` — required for `window.roomy.chat.sendMessage()`.

## Params

| Param      | Type   | Description                                                     |
|------------|--------|-----------------------------------------------------------------|
| `question` | string | The question to display.                                        |
| `options`  | string | Comma-separated labels or a JSON array.                         |
| `min`      | number | Minimum selections required (default `1`).                      |
| `max`      | number | Soft cap on selections (advisory; documented for callers).      |

Attach example:

```
roomy-agent chat attach-artifact \
  /opt/roomy-apps/chat-forms.app/dist/fragments/multi-select \
  --param question="Which days work?" \
  --param options="Mon,Tue,Wed,Thu,Fri" \
  --param min=1
```

## Storage contract

This fragment does not use persistent app storage.

## When to use

"Select all that apply" questions. For exactly-one-answer use `single-choice`;
for binary yes/no use `yes-no`.
