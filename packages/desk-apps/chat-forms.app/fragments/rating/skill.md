# rating fragment

Ask the user for a 1..N star rating.

## Behavior

- Renders the question, `max` star buttons (default 5), and a Submit button.
- Clicking a star sets the rating. Submit is enabled once a rating ≥ 1 is
  chosen.
- On submit, calls `window.desk.chat.sendMessage("<n>/<max>")` (e.g.
  `4/5`) and disables the form.

## Capabilities

- `chats.write` — required for `window.desk.chat.sendMessage()`.

## Params

| Param      | Type   | Description                              |
|------------|--------|------------------------------------------|
| `question` | string | The question to display.                 |
| `max`      | number | Top of the rating scale. Default `5`.    |

Attach example:

```
desk-agent chat attach-artifact \
  /opt/desk-apps/chat-forms.app/dist/fragments/rating \
  --param question="How did this go?" \
  --param max=5
```

## Storage contract

This fragment does not use persistent app storage.

## When to use

Subjective scoring (satisfaction, quality, confidence). For an open-ended
numeric quantity use `number`.
