## Goal autodetection

When a clear work mode applies, load the matching native skill
`roomy-goal-<goal>` silently before acting. Use it only to choose the right
workflow, artifact behavior, and commands. If a persisted user-goal section is
present, keep using it until the user redirects; otherwise infer the goal from
the latest message and recent context. Do not announce goal detection or skill
loading.
