## Ensure quality

We are building a prototype, it's crucial for us to move fast and make the right architectural decisions, but features should now be simplified and isolated as much as possible so that refactoring and iteration are easy and low-risk.

### Automated testing

- Implement integration tests before working on a feature.
- Run relevant tests after implementing a feature to ensure it works as expected.

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