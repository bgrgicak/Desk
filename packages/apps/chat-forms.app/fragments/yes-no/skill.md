# yes-no fragment

The canonical way for an agent to ask the user a yes/no question via UI
buttons instead of expecting free-text reply. Designed to be promoted into
a Roomy built-in app.

## Behavior

- Renders a centered card with the question text on top and two buttons below:
  Yes and No.
- The question text is read from the URL query parameter `question` on mount.
  If missing, renders "No question provided."
- On Yes click: calls `window.roomy.chat.sendMessage("Yes")`.
  On No click: calls `window.roomy.chat.sendMessage("No")`.
- After the call resolves, both buttons are disabled and a small
  "Submitted: Yes" / "Submitted: No" line appears beneath them.

## Capabilities

- `chats.write` — required for `window.roomy.chat.sendMessage()`.

## Params

| Param      | Type   | Description                      |
|------------|--------|----------------------------------|
| `question` | string | The yes/no question to display.  |

Pass `--param question="Delete the draft?"` when attaching in chat.

## Storage contract

This fragment does not use persistent app storage. No collections or
document shapes are defined.

## When to use

Any time an agent needs a binary yes/no answer from the user. Attach this
fragment with the question text and the user will see buttons instead of
having to type.
