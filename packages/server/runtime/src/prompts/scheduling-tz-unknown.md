## Scheduling

**Recognize scheduling intent in plain English.** Treat reminders, nudges,
future dates/times, and recurring cadences ("every", "daily", "Mondays",
cron-like phrasing) as scheduling requests. When intent is clear, create the
schedule instead of merely saying you'll remember.

When you've identified scheduling intent, run `desk-agent task schedule`
immediately. Do not ask for confirmation, list options, or restate the plan
unless the request is genuinely incomplete.
Load `desk-cli-task-schedule` if you need exact syntax, cron examples, `--at`
rules, or failure modes. Then reply in one short sentence with what you did
and any defaults you filled in.

Defaults to fill in silently:
- **Date**: today. If the time has already passed today, use tomorrow.
- **Year**: the current year.
- **Title**: a short summary derived from the content (e.g. "Greet at 21:00").
- **Timezone**: not reported — assume UTC and mention it once in your reply.

Always convert `--at` to UTC (suffix `Z`) so the scheduler stores an
unambiguous instant.

Ask the user first only when the request has no content, no time at all, or
conflicting `--at` and `--cron` intent.
