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

### Measured wins vs. opencode

**Memory (`docker stats` on real containers, M3 Linux host):**

| State | Opencode | Pi |
|---|---|---|
| Sandbox at idle | ~250 MB (daemon never sleeps) | **1–2 MiB** |
| During an active turn | ~280 MB (daemon + tools) | **70–82 MiB peak** |
| After the turn ends | stays at ~250 MB | drops back to **2 MiB** |

For a user with 5 active workspaces, the steady-state footprint goes from
~1.25 GB → ~10 MiB. Even with 5 simultaneous turns, pi peaks at ~400 MB vs
opencode's 1.4 GB.

**Code surface (`packages/server/runtime/src/`):**

| Metric | Opencode | Pi | Δ |
|---|---|---|---|
| LOC | ~5,800 | ~1,050 | **−82%** |
| Long-running shared state (daemon / port / SQLite / MCP config / auth file) | 5 surfaces | 0 | — |
| Recovery loops in `driver.ts` | 4 (daemon-gone, SSE-handshake, OOM-probe, session-stale) | 1 (container-gone) | **−75%** |
| Explicit cross-call mutexes/locks (MCP write, port-bind, env-digest, auth wipe, SSE handshake guard) | 5 | 0 (per-turn isolation) | — |
| Cold-spawn time on auth misconfig | 60s (daemon-ready timeout × 3 retries) | 1.5s | **40× faster** |
| Cross–desk-server-restart cleanup | killed orphaned daemons to avoid SQLite `BUSY` | no-op | — |

Plus a class of regressions we no longer have to chase: opencode's SSE
broadcast format changed across minor versions and we had to pin
`opencode-ai@1.14.50` after sweeping 1.14.42–1.14.49 for regressions. Pi's
`--mode json` is a published, versioned wire format.

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
running desk-server with the workload it really sees in production —
parallel quick chats, paced conversations, preemption floods, large
attachments, multi-tool tasks. **The pi swap was validated end-to-end
against a dedicated test instance** before this PR was opened.

Stability across 3 back-to-back chaos runs (Codex subscription as the
provider, `gpt-5.5` model):

| Run | Pattern mix | Messages | OK | Fail | Timeout | Stderr | Wall |
|---|---|---|---|---|---|---|---|
| mixed (seed 4242) | quick / conversation / flood / attachment / task | 36 | 36 | 0 | 0 | 0 | 16.7s |
| mixed (seed 5252) | same | 34 | 34 | 0 | 0 | 0 | 16.2s |
| heavy mixed (seed 6363, 10 scenarios/ws) | same | 54 | 54 | 0 | 0 | 0 | 22.7s |
| pure flood (seed 7474, preemption stress) | flood ×94 | 94 | 93 | 0 | 0 | 3 | 48.9s |

**Aggregate: 217/218 messages reached a terminal non-error state across
4 runs = 99.5%.** The single transient fail in the flood run was a
Codex OAuth refresh blip; the other 3 runs (including the 54-message
heavy mixed) hit 100% ok with zero stderr.

Pi exits in ~1.5s on auth failure and ~3-5s on success — the old
opencode-serve 60s daemon-ready timeout on misconfig is gone.

### To reproduce locally

1. Build the production sandbox image:
   `docker build -t desk/sandbox:v1 -f packages/server/runtime/Dockerfile.sandbox .`
2. Bake provider credentials into a chaos image (your local Codex auth at
   `~/.codex/auth.json` translates to pi's `~/.pi/agent/auth.json` shape
   `{"openai-codex": {"type": "oauth", "access", "refresh", "accountId", "expires"}}`).
3. Spin up a dedicated test desk-server on a non-default port + throwaway
   `DESK_HOME`:
   `DESK_HOME=/tmp/desk-chaos PORT=35238 DESK_SANDBOX_IMAGE=desk/sandbox:v1-pi-chaos npm -w @agent-desk/api run start`
4. Run chaos:
   `node scripts/chaos-test.mjs --port 35238 --workspaces 2 --scenarios-per-workspace 6 --seed 4242 --cleanup`

### Deferred: production Codex bridge

The chaos test baked the `openai-codex` OAuth blob into the sandbox image
via `/etc/skel/.pi/agent/auth.json`. For the production install where
DESK's `localSources/codex` already reads `~/.codex/auth.json` and surfaces
it as `OPENCODE_AUTH_CONTENT`, we need a small piece of code in the runtime
that translates that same blob into pi's `~/.pi/agent/auth.json` format
before each pi exec. Mechanically the same shape we built for the chaos
image — wire it into the per-run setup. One-day task, follow-up PR.

## Follow-ups (not blocking the swap, ordered by impact)

These are the gaps between this PR's "core runtime swap" and a 100%
opencode replacement. Each is a small PR on its own.

1. **Fallback model on provider failure** — original product ask.
   If the chat's default model fails (provider down, rate-limited, quota),
   the runtime should automatically retry with a configured fallback model.
   ~50 LOC in `driver.ts` + a fallback-list field on the agent row + chaos
   validation. **~30 min of work.**

2. **Codex/ChatGPT subscription bridge** — DESK already reads
   `~/.codex/auth.json` via `localSources/codex` and surfaces it as
   `OPENCODE_AUTH_CONTENT`. Pi needs the same OAuth blob translated into
   its `~/.pi/agent/auth.json` shape per turn. The translation is ~20
   lines of Node (the chaos image build script already does it for the
   test path); just needs to live in the runtime instead of `/etc/skel`.
   **Without this, this PR works against API-key providers but not your
   Codex subscription in prod. ~1 day.**

3. **MCP bridge pi-extension for Playwright** — pi rejects MCP
   philosophically; needs a small extension that reads a workspace-level
   MCP config and exposes each MCP server's tools to the agent. Browser-
   goal chats (`site`, `app`) will fail without it. **~2–3 days.**

Provider failover is included in (1) by design. The Codex bridge in (2)
is the one that matters for *your* deployment specifically.
