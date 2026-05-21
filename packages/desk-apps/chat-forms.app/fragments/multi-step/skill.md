# multi-step fragment

Ask the user several structured questions in one chat turn via an in-iframe
wizard. The user walks Back/Next through the steps locally and the final
Submit sends one consolidated chat message containing every answer.

## Behavior

- Reads the URL `steps` param (JSON-encoded array of step objects), validates
  it, and renders the first step.
- Shows a "Step N of M" indicator above the question. Pass `showProgress=false`
  in the URL params to hide it (useful for short or casual flows where the
  count adds visual noise).
- For each step:
  - `yes-no` steps auto-advance on click.
  - Other types require a Next button click. The button enables once the
    step's value is valid (non-empty text/number, ≥ `min` selections for
    multi-select, etc.).
  - Back is available from step 2 onward.
- On the final step, Submit replaces Next. Submit sends a single markdown
  message of the form:

  ```
  **Q1: <question>**
  A: <answer>

  **Q2: <question>**
  A: <answer>
  ```

  via `window.desk.chat.sendMessage(...)`, then disables the wizard and
  shows "Submitted.".

## Capabilities

- `chats.write` — required for `window.desk.chat.sendMessage()`.

## Step schema

Each step is one of:

```json
{ "id": "q1", "type": "yes-no",        "question": "..." }
{ "id": "q2", "type": "single-choice", "question": "...", "options": ["a","b"] }
{ "id": "q3", "type": "multi-select",  "question": "...", "options": ["a","b"], "min": 1, "max": 3 }
{ "id": "q4", "type": "short-text",    "question": "...", "placeholder": "..." }
{ "id": "q5", "type": "long-text",     "question": "...", "placeholder": "..." }
{ "id": "q6", "type": "number",        "question": "...", "min": 1, "max": 99 }
{ "id": "q7", "type": "date",          "question": "..." }
{ "id": "q8", "type": "rating",        "question": "...", "max": 5 }
```

`id` is optional — defaults to `q<index+1>` and is only used as a React key
during rendering. `question` is required.

## Params

| Param          | Type    | Description                                                                                            |
|----------------|---------|--------------------------------------------------------------------------------------------------------|
| `steps`        | string  | JSON-encoded array of step objects. Must be non-empty.                                                 |
| `showProgress` | boolean | Optional. Defaults to `true`. Set to `false` to hide the "Step N of M" indicator. Always hidden for 1-step forms. |

Attach example:

```
desk-agent chat attach-artifact \
  /opt/desk-apps/chat-forms.app/dist/fragments/multi-step \
  --param steps='[
    {"type":"short-text","question":"What is the project called?"},
    {"type":"single-choice","question":"What kind of project?","options":["plugin","theme","site"]},
    {"type":"date","question":"When do you want to ship?"},
    {"type":"yes-no","question":"Should I scaffold a starter repo?"}
  ]'
```

## Storage contract

This fragment does not use persistent app storage. All wizard state is held
in memory until the final Submit, after which one chat message is posted
back.

## When to use

Onboarding flows, structured intake, multi-field configuration — anything
where you'd otherwise ask the user 3+ separate questions in a row. For a
single question, use the matching single-question fragment instead so the
user gets a focused UI without wizard chrome.
