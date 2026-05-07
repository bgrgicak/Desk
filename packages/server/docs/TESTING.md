# Testing

## Required environment

| Variable | Default | Purpose |
|---|---|---|
| `DESK_HOME` | `$HOME` | Where the test fixture writes per-run sqlite + workspace dirs (under a `mkdtemp` subdir, not the user's real `~/Desk`) |
| Docker daemon | auto-detected | Sandbox integration tests run when `docker info` succeeds. Rootful and rootless Linux + macOS Docker Desktop all work |
| `at` / `crontab` | auto-detected | Scheduler integration tests run when the commands are available |

Real AI tests use the free `opencode/big-pickle` model and require no API key.

## Running tests

```bash
# Vitest unit + integration suite (host)
npm run test:host

# Playwright e2e (spawns desk-server + Vite preview)
npm run test:e2e
```

## CI layout

GitHub Actions runs the independent gates in parallel:

1. `Typecheck` runs `npm run typecheck`.
2. `Vitest (host suite)` builds the sandbox CLI and `desk/sandbox:v1`, then runs the host Vitest suite.
3. `Playwright e2e` builds `@agent-desk/api` and its Nx dependencies, installs Chromium, then runs the UI e2e suite with the fake sandbox driver.

The final `Test (host suite)` job is an aggregate compatibility check that fails unless all three parallel jobs pass.

## Test tiers

### Unit tests
Pure logic, no external dependencies. Examples: error mapping, OpenAPI
spec generation, WS registry, mount path calculation.

### Integration tests
Hit real backends (SQLite, Docker, `at`/`crontab`). Each test gets an
isolated `mkdtemp` `DESK_HOME` and SQLite file. Auto-detected — skipped
when the backend is unavailable, not gated by opt-in env vars.

### End-to-end tests
Full server stack: HTTP server against real SQLite, real auth, real
WebSocket upgrade, real run lifecycle. The API `e2e.test.ts` exercises
login, CRUD, message sending, run triggering, and WebSocket event
delivery. The Playwright suite drives the UI through Vite's preview
proxy at `:5179`.

The runtime `opencode.test.ts` and the API `e2e.test.ts` real-stack
block exercise a real AI invocation inside a real Docker container
against the free `opencode/big-pickle` model — no API key required.
They auto-skip when the sandbox image isn't available locally.

## Test isolation

Each test creates a fresh `DESK_HOME` under `$TMPDIR` and an SQLite file
inside it. Migrations run on first connection — no admin database, no
manual schema setup. Tests that need a sandbox container reuse the
host's `desk/sandbox:v1` image; build it once with the command in
[`README.md`](../README.md).

## Adding new tests

Follow the existing pattern:

1. `mkdtemp` a `DESK_HOME` per test.
2. Set `DESK_DB_PATH` under it; migrations run automatically.
3. For Docker/scheduler tests, auto-detect availability instead of
   gating on opt-in env vars.
4. Tear down in `afterAll`.
