# date fragment

Ask the user for a calendar date.

## Behavior

- Renders the question, a focused `<input type="date">`, and a Submit button.
- Submit is enabled once a date is picked.
- On submit, calls `window.roomy.chat.sendMessage("YYYY-MM-DD")` and disables
  the form.

## Capabilities

- `chats.write` — required for `window.roomy.chat.sendMessage()`.

## Params

| Param      | Type   | Description              |
|------------|--------|--------------------------|
| `question` | string | The question to display. |

Attach example:

```
roomy-agent chat attach-artifact \
  /opt/roomy-apps/chat-forms.app/dist/fragments/date \
  --param question="When should I follow up?"
```

## Storage contract

This fragment does not use persistent app storage.

## When to use

Any single-date question (deadline, follow-up, birthday). Date-range or
date+time questions are not supported by this fragment yet — fall back to
plain text.
