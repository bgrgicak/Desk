## Ensure quality

We are building a prototype, it's crucial for us to move fast and make the right architectural decisions, but features should now be simplified and isolated as much as possible so that refactoring and iteration are easy and low-risk.

### Automated testing

- Implement integration tests before working on a feature.
- Run relevant tests after implementing a feature to ensure it works as expected.
- **Tests must be real**: real Postgres, real Docker, real Anthropic API. No fakes as the only coverage of any surface. Fakes may exist for dev ergonomics but every faked surface must also have a real-backend counterpart.
- For substantial feature work or cross-package changes, run `npm run ci:local` before calling the work complete, or explicitly report why it could not be run. This requires Node 23 and Docker.
- Use `nvm` to select the repo-pinned Node version from `.nvmrc` before running npm commands. Do not rely on `/usr/bin/node`. If `nvm use` reports an npm `prefix`/`globalconfig` conflict, use the command it suggests, for example `nvm use --delete-prefix v22.22.2 --silent`, then run the repo command again without editing the user's npm config.
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
