# Migration: opencode → pi runtime

Branch: `worktree-feat+pi-runtime`. Single commit on a fresh worktree.

## Why

Opencode pain: heavyweight long-lived daemon per container, fragile HTTP/SSE
multiplexer, env-digest restart dance, MCP-config write lock, persistent
auth wipe, port allocation races, SQLite contention on desk-server restart.

Pi ([@earendil-works/pi-coding-agent](https://github.com/badlogic/pi-mono))
is a CLI coding agent that runs as one short-lived subprocess per turn,
auto-saves its own sessions, and exposes a clean `--mode json` event stream.
We embed it inside the sandbox container and spawn it via `docker exec` per
turn — no daemon, no HTTP, no SSE, no port, no shared MCP config, no auth
file.

## Architecture

```
Old (opencode):                          New (pi):
─────────────────                        ──────────────
desk-server                              desk-server
  └─ HTTP/SSE → opencode serve daemon      └─ docker exec pi -p --mode json ...
      (per container, long-lived)             (per turn, short-lived)
      ├─ port publish (9105)                  ├─ stdout = JSON event lines
      ├─ HTTP Basic auth                      ├─ stderr = log lines
      ├─ SSE multiplexer                      ├─ session = /home/agent/.pi/agent/sessions/<chatId>
      ├─ SQLite (auth + sessions)             └─ exit code = success/abort/error
      ├─ MCP config file race
      └─ env-digest restart
```

Pi sessions land at `/home/agent/.pi/agent/sessions/` inside the container,
which **is the workspace bind-mount**, so chat history survives container
reaping for free.

## What changed in `packages/server/runtime`

| File | Status |
|---|---|
| [`src/piEvents.ts`](../../runtime/src/piEvents.ts) | **new** — translates pi's `--mode json` events into the existing `{type, part, sessionID}` run-format JSON shape |
| [`src/piClient.ts`](../../runtime/src/piClient.ts) | **new** — spawns pi via `docker exec`, drains stdout/stderr, supports cancel |
| [`src/driver.ts`](../../runtime/src/driver.ts) | **rewritten** — no HTTP client, no SSE handshake, no env-digest restart, no OOM probe, no session-recreate retry |
| [`src/opencode.ts`](../../runtime/src/opencode.ts) | **rewritten** — `execRun` slim composer; dropped `withMcpLock`, `writeWorkspaceMcpConfig`, `ensureContainerXvfb`, `restartOpencodeServer` calls |
| [`src/agentFile.ts`](../../runtime/src/agentFile.ts) | **rewritten** — writes `AGENTS.md` at workspace root (pi auto-discovers it); dropped opencode permission YAML, MCP config writer, model-line digest |
| [`src/models.ts`](../../runtime/src/models.ts) | **rewritten** — shells `pi --list-models` instead of `opencode models --verbose` |
| [`src/mounts.ts`](../../runtime/src/mounts.ts) | `SKILLS_SANDBOX_DIR` → `/home/agent/.agents/skills` (pi's discovery path) |
| [`src/goalSkills.ts`](../../runtime/src/goalSkills.ts) | dropped `compatibility: opencode` frontmatter line |
| [`src/docker.ts`](../../runtime/src/docker.ts) | dropped `OPENCODE_SERVE_CONTAINER_PORT` publish, bumped `SANDBOX_RUNTIME_TAG` → `pi-runtime-v1` (forces drift-recreate of old containers), stubbed `softReapIdleDaemons` and `killOpencodeDaemonsForOrphans` to no-ops |
| [`src/connectionRefresh.ts`](../../runtime/src/connectionRefresh.ts) | simplified — under pi, only chat-session-id clearing is needed (no daemon to restart) |
| [`src/index.ts`](../../runtime/src/index.ts) | exports `buildPiEnv` alongside the `buildDaemonEnv` alias |
| `src/opencodeServer.ts` | **deleted** |
| `src/opencodeClient.ts` | **deleted** |
| `src/opencodeEvents.ts` | **deleted** |
| `opencode.managed.json` | **deleted** |
| `bench/chat-perf.ts` | **deleted** |
| `test/opencode.test.ts` / `opencodeServer.test.ts` / `opencodeEvents.test.ts` / `integration/opencode.test.ts` / `integration/sandbox.test.ts` | **deleted** (tested daemon machinery that no longer exists) |
| `test/driver.test.ts` | **rewritten** — covers `buildPiEnv`, `parseModelSpec`, `buildPiPrompt`, `isContainerGoneError` |
| `test/agentFile.test.ts` | **rewritten** — asserts AGENTS.md shape, no opencode frontmatter |
| `test/models.test.ts` / `test/goalSkills.test.ts` / `test/docker.test.ts` | updated assertions |

Production model defaults flipped from `opencode/big-pickle` →
`anthropic/claude-haiku-4-5` in:

- [`packages/server/scheduler/src/runs.ts`](../../scheduler/src/runs.ts) (`FALLBACK_MODEL`)
- [`packages/server/scheduler/src/runs-summary.ts`](../../scheduler/src/runs-summary.ts)
- [`packages/server/api/src/routes/workspaces.ts`](../../api/src/routes/workspaces.ts) (`DEFAULT_AGENT_MODEL`)
- [`packages/server/db/src/queries/agents.ts`](../../db/src/queries/agents.ts)
- [`packages/server/db/src/seed.ts`](../../db/src/seed.ts)

## Sandbox image

[`packages/server/runtime/Dockerfile.sandbox`](../../runtime/Dockerfile.sandbox)
now installs `@earendil-works/pi-coding-agent@0.75.4` and **does not** ship
opencode-ai or playwright/firefox/Xvfb (MCP is deferred — see below).

[`packages/server/runtime/sandbox-entrypoint.sh`](../../runtime/sandbox-entrypoint.sh)
symlinks `/opt/desk-skills` → `~/.agents/skills` (pi's discovery path).

**Action required before integration tests pass locally / CI:**

```sh
docker build -t desk/sandbox:v1 -f packages/server/runtime/Dockerfile.sandbox .
```

## Deferred: MCP

The user explicitly chose to ship without MCP. Pi has no built-in MCP
support. Consequences:

- Browser-goal chats (`site`, `app`) no longer auto-start Playwright. The
  agent will fail when it tries to drive a browser.
- The `chatNeedsBrowser` heuristic, `writeWorkspaceMcpConfig`, the
  `withMcpLock` per-workspace serial queue, and `ensureContainerXvfb` are
  all gone.

Plan for follow-up: write a small pi extension
(`packages/server/runtime/pi-extensions/mcp-bridge/`) that reads a
workspace-level MCP config and exposes each MCP server's tools to the
agent.

## Deferred: tests that store `opencode/big-pickle` as a literal

Many test fixtures still pass `model: "opencode/big-pickle"` to API/DB
helpers. The string is just stored on the agent row; it isn't actually
invoked at runtime because those tests use the fake driver. They keep
passing as-is. A bulk rename is mechanical and can be a follow-up PR.

## Verification

```sh
npm -w @agent-desk/runtime test   # 151/154 pass; 3 integration tests need rebuilt image
npx tsc --noEmit -p packages/server/runtime    # clean
npx tsc --noEmit -p packages/server/scheduler  # clean
```

The api typecheck currently shows three errors about `libraryFileAuthors`/
`FileRef.agentId`. Confirmed pre-existing on trunk (the main repo's
`db/dist/` has those types but `db/src/queries/index.ts` doesn't re-export
them) — unrelated to this swap.

## Chaos testing against this branch

[`packages/server/docs/CHAOS_TESTING.md`](../CHAOS_TESTING.md) hammers a
running desk-server. To validate the pi swap end-to-end:

1. Build the new sandbox image (one-time, ~2 min):
   `docker build -t desk/sandbox:v1 -f packages/server/runtime/Dockerfile.sandbox .`
2. Spin up a dedicated test desk-server on a non-default port pointed at a
   throwaway `DESK_HOME` so chaos can't pollute the daily-use instance:
   `DESK_HOME=/tmp/desk-chaos PORT=35238 npm -w @agent-desk/api run start`
3. Run chaos against it:
   `node scripts/chaos-test.mjs --port 35238 --workspaces 2 --scenarios-per-workspace 6 --seed 4242 --cleanup`

The chaos test's exit code is `failed + timeout + errs`; `0` means every
message reached a terminal non-error state.

## Provider failover

Not implemented in either runtime. Pi-ai (pi's provider abstraction) is
the natural place to put a ~100-line wrapper around `setModel` + error
detection. Out of scope for this PR.
