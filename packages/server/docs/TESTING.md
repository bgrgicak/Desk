# Testing

## Required environment

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` or `DESK_TEST_DATABASE_URL` | `postgresql://desk:desk@127.0.0.1:55432/desk` | Admin Postgres connection for creating per-worker test databases |
| `ANTHROPIC_API_KEY` | (none) | Enables real AI end-to-end tests. Loaded from `.env` at repo root |
| Docker daemon | auto-detected | Sandbox integration tests run when `docker info` succeeds |
| `at` / `crontab` | auto-detected | Scheduler integration tests run when the commands are available |

## Running tests

```bash
# Full suite (DB + Docker + AI when key is set)
npm test

# E2E tests (VM-level, requires provisioned VM)
npm run test:e2e

# Single package integration tests
cd packages/server/db && npx vitest run --config vitest.integration.config.ts
```

## Test tiers

### Unit tests
Pure logic, no external dependencies. Examples: error mapping, OpenAPI spec generation, WS registry, mount path calculation.

### Integration tests
Hit real backends (Postgres, Docker, `at`/`crontab`). Each test worker gets an isolated database (`desk_<pkg>_test_<worker_id>`). Auto-detected — skipped when the backend is unavailable, not gated by opt-in env vars.

### End-to-end tests
Full server stack: HTTP server against real Postgres, real auth, real WebSocket upgrade, real run lifecycle. The API `e2e.test.ts` exercises login, CRUD, message sending, run triggering, and WebSocket event delivery.

When `ANTHROPIC_API_KEY` is set, the runtime `opencode.test.ts` exercises a real AI invocation inside a real Docker container.

## Test database isolation

Each package creates isolated test databases named `desk_<pkg>_test_<VITEST_WORKER_ID>`. The admin connection is derived from `DATABASE_URL` by switching the database name to `postgres`. Databases are created in `beforeAll` and dropped in `afterAll`.

## Adding new tests

Follow the existing pattern:
1. Derive admin/test connection strings from `DATABASE_URL` env var
2. Create an isolated test database per worker
3. Run migrations and seed data
4. Clean up in `afterAll`
5. For Docker/scheduler tests, auto-detect availability instead of gating on opt-in env vars
