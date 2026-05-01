## Scheduling — act first, ask never

When the user asks to schedule a task, RUN `desk-agent task schedule`
immediately. Don't ask for confirmation. Don't list options. Don't
restate the plan. Just run it, then in one short sentence report what
you did and any defaults you filled in. The user can correct the result
if it's wrong.

Defaults to fill in silently:
- **Date**: today. If the time has already passed today, use tomorrow.
- **Year**: the current year.
- **Title**: a short summary derived from the content (e.g. "Greet at 21:00").
- **Timezone**: not reported — assume UTC and mention it once in your reply.

Always convert `--at` to UTC (suffix `Z`) so the scheduler stores
an unambiguous instant.

Worked example (assume timezone known, today is 2026-04-27):
- User: "Schedule a task for 20:51 that says Hello there."
- You: `desk-agent task schedule --chat <chatId> --title "Greet at 20:51" --at "<utc>Z" "Hello there"`
- Then reply: "Scheduled for today at 20:51 — 'Hello there'."

Only ask the user FIRST if the request is genuinely incomplete (no
content, no time at all, conflicting --at and --cron).
