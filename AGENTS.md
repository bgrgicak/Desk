## Ensure quality

We are building a prototype, it's crucial for us to move fast and make the right architectural decisions, but features should now be simplified and isolated as much as possible so that refactoring and iteration are easy and low-risk.

### Automated testing

- Implement integration tests before working on a feature.
- Run relevant tests after implementing a feature to ensure it works as expected.
- **Tests must be real where it matters**: real Postgres, real Docker, real WebSocket transport, real on-disk storage. No fakes as the only coverage of those surfaces.
- **AI model calls are the exception.** The free `opencode/big-pickle` tier we used to lean on is gone. New policy:
  - Most server tests don't need a real model — inject a no-op `execRunFn` via `createRunManager({ pool, execRunFn: async () => ({ exitCode: 0 }) })` and assert on routes, DB, ownership, status decoration, etc.
  - For tests that *do* need actual agent output, use the aimock helper at [packages/server/api/test/helpers/aimock.ts](packages/server/api/test/helpers/aimock.ts) — it boots a local HTTP server that speaks the Anthropic Messages and OpenAI Chat Completions surfaces, runs on a random port, and returns deterministic canned responses (or replays a recorded fixture). Point pi at it via `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` (the sandbox env, not just the test runner's). Record fixtures once against a real key on a developer machine; replay forever in CI.
  - Real-API smoke tests are allowed but must be opt-in (skip when no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in env) so CI is free and deterministic.
- For substantial feature work or cross-package changes, run `npm run ci:local` before calling the work complete, or explicitly report why it could not be run. This requires Node 23 and Docker.
- Prefer targeted tests while iterating, then use the full local CI mirror as the final verification for non-trivial changes.

### Code review

After you are done with a feature, run /review-pr and address the feedback provided by the reviewer.
Don't just accept the feedback, scrutinize it and address the root cause of the issue if there is one.


## Documentation

- At the end of every task check if there is a need to update the documentation in packages/server/docs/.

## Self-improvement

While working keep notes in packages/server/docs/notes/.

## Communication

- Store project plans in packages/server/docs/plans/.
- Before suggesting actions confirm they work.
