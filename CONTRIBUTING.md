# Contributing to Desk

Thanks for picking up Desk. The bar for this codebase is "real users hit
it daily" — every change should preserve that. The notes below cover
what's enforced automatically vs reviewed manually, and the few
conventions we ask new contributors to follow.

## Prerequisites

- Node.js 23.x — pinned by `.nvmrc` and `engines`. Use volta/fnm/nvm/mise/asdf.
- Docker — rootful or rootless on Linux, Docker Desktop on macOS. Or
  nerdctl + containerd if Docker can't coexist.
- An API key is _not_ needed for development — the free
  `opencode/big-pickle` model handles everything that needs an AI.

## First-time setup

```bash
git clone git@github.com:bgrgicak/Desk.git
cd Desk
npm install        # also installs the pre-commit hook
npm run dev        # boots desk-server + Vite
```

Open <http://localhost:5173/>, sign in as `desk` / the
`DESK_SEED_PASSWORD` (default `change-me-before-first-boot`).

## What's enforced automatically

### Pre-commit hook (installed by `npm install`)

Runs against every commit, on every file you've staged.

| Check                                                             | Why it exists                                                                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                               | Catches type errors before they reach CI.                                                                                                |
| `vitest run` (unit + component, no integration, no e2e)           | Real Postgres / Docker / AI tests are gated to CI because they need a workstation set up for them; this gate is fast and runs everywhere. |

If a hook fails, fix the underlying issue rather than bypassing with
`--no-verify`. The hook is intentionally narrow so it stays fast — the
heavier checks live in CI.

### Continuous integration (`.github/workflows/ci.yml`)

Triggers on `push` to `trunk` and on pull requests against it.

| Job                          | What it covers                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Typecheck**                | `npm run typecheck` across every workspace.                                                                                 |
| **Vitest (unit suite)**      | Pure-logic tests with no external dependencies.                                                                             |
| **Vitest (integration suite)** | Real SQLite, real Docker, real `at` / `crontab`. Auto-detects backend availability.                                      |
| **Playwright e2e**           | Real desk-server + Vite preview. Drives the UI end-to-end against the fake sandbox driver.                                  |
| **Prepare sandbox image**    | Builds `desk/sandbox:v1` once; later jobs download the saved image instead of re-building.                                  |
| **Build desktop app (macOS)** | Validates the Electron wrapper still installs / packages cleanly.                                                          |

The aggregate `test` job fails unless every required parallel job
succeeds. Branch protection on `trunk` should require this aggregate
check before merge.

### Dead-code scanner (advisory)

```bash
npx knip
```

Runs against the committed `knip.json` config. Not yet wired into CI as
a blocking gate — contributors are welcome to run it locally before
landing a feature and either remove what it flags or add a justification
in `knip.json`'s `ignore` list.

## What's reviewed manually

A pull-request reviewer should be able to answer "yes" to each item
below before approving. The PR template includes this list as a
checklist.

- Does the change include a test for the behaviour it touches?
- New HTTP route: rate-limited where bruteforce or abuse is possible
  (look at `auth/rateLimit.ts` for the helpers)? Auth-checked?
  Ownership-checked? Input validated with the existing Zod patterns?
  Returns the standard `{code, message, details?}` shape on error?
- New sandbox env var: provider key? Logged to
  `provider_key_access_log` via `logKeyAccess(...)`?
- New external service integration: connection stored via the generic
  connector store, not a one-off table?
- No raw `console.*` in server source — log via the structured logger
  if you need persistence, or `toast.error()` in the app.
- Source file under 600 lines, with a deliberate justification if not.
- New flaky test: root-cause fix or `it.todo()` with a tracking issue
  link. Retries should be the exception, not the strategy.
- New form in the app: uses `react-hook-form` + Zod schema (work in
  progress — once the pattern is in place, the rule is uniform).
- New mutation site: `.unwrap()` wrapped in a `.catch()` that surfaces
  the error to the user (toast or banner). Silent failures are a bug.

## Coding conventions

- **TypeScript strict mode is on everywhere.** No `any`; if a third-
  party type makes that hard, narrow with a type guard rather than a
  cast.
- **No barrel files** beyond each package's existing `src/index.ts` —
  they make tree-shaking unpredictable and slow tsc.
- **Prefer Zod parsing at boundaries** (HTTP handlers, sandbox tokens)
  and trust the parsed type from there on. Don't double-validate.
- **No commented-out code in commits.** If you're unsure, delete it
  and reach for git history later.
- **No `console.*` in `packages/server/**/src/`.** Use the structured
  logger. The app and tests are exempt for now.
- **Errors that hit the user are toasts, not exceptions logged to the
  devtools console.** `extractApiError(err)` in `@/lib/api-error`
  pulls the server's `data.message` when present.

## Commit & PR style

- Commit messages: imperative mood, first line ≤ 70 chars
  ("Add X" / "Fix Y" / "Remove Z"). Body explains *why* the change
  matters and *why* this approach over the obvious alternative.
- Pull requests should land as a series of focused commits rather than
  one giant squash — it makes review and bisecting easier.
- Don't rebase a branch other people are reviewing without warning
  them in the PR thread.

## When something is unclear

- **Architectural questions:** start a thread in the PR description or
  open an issue. Move fast, but not so fast that an architectural
  decision happens without daylight.
- **Stuck CI:** the workflow logs are linked from each PR. Reviewers
  expect a green build, so debug failures before requesting review.
- **Anything else:** open an issue — even if it's only to say "I'm not
  sure where this belongs."

Thanks for keeping the bar high.
