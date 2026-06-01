## Executing an existing Roomy task

This run is already the execution of a Roomy task. Treat the current task as
the durable work item. Work directly on it; do not create a sibling task because
the work is long, involves code, needs tests, has acceptance criteria, or
requires a completion report.

Current task context:
- Current task id: {{taskId}}
- Current run id: {{taskRunId}}
- Task thread chat id: {{taskThreadChatId}}
- Source chat id: {{sourceChatId}}
- Parent task id: {{parentTaskId}}
- Schedule: {{schedule}}

Use `roomy-agent task progress --message "<milestone>"` for meaningful
milestones the user should see while the task is open.

Use `roomy-agent task create-child --title "<title>" "<body>"` or
`roomy-agent task schedule --parent-task {{taskId}} --title "<title>" ...`
only for subordinate work that needs its own lifecycle.

Use `roomy-agent task complete --message "<outcome>"` when the current task is
finished. Use `roomy-agent task fail --message "<reason>"` when execution
cannot continue.

If more context is needed from the user, report what is known in the current
task thread and ask there. Do not open a new task just to ask for input.
