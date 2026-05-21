# Chaos testing

[`scripts/chaos-test.mjs`](../../../scripts/chaos-test.mjs) stress-tests
sandbox robustness by hammering the running API directly: it spins up
fresh project workspaces, opens many chats in parallel, fires a mix of
message patterns (quick questions, paced conversations, preemption
floods, file attachments, long multi-tool tasks), and tracks every
user message through to its agent reply's terminal state.

Runs against any deployment that exposes the standard HTTP + WebSocket
API — no app UI involvement, no test seed.

## Prerequisites

- `desk-server` reachable (default `http://127.0.0.1:35138`).
- Node 23+ (matches the rest of the repo).
- `ws` package — already a workspace dependency, no install step.

Auth is automatic in dev: the script tries `POST /auth/auto-login`
first and falls back to credential-based `POST /auth/login` only when
auto-login is disabled. Override with `--username` / `--password` (or
`DESK_USERNAME` / `DESK_PASSWORD`).

## Usage

```bash
# Defaults: 2 workspaces × 5 scenarios = 10 chats, weighted pattern mix
node scripts/chaos-test.mjs

# Heavy load
node scripts/chaos-test.mjs --workspaces 2 --scenarios-per-workspace 10

# Preemption focus: stack messages faster than turns can drain
node scripts/chaos-test.mjs --pattern flood --scenarios-per-workspace 8

# Only attachments
node scripts/chaos-test.mjs --pattern attachment

# Reproducible run; delete workspaces after
node scripts/chaos-test.mjs --seed 42 --cleanup

# Per-event streaming
node scripts/chaos-test.mjs --verbose

# Non-default host / port
node scripts/chaos-test.mjs --host 192.168.1.5 --port 35138
```

All flags:

| Flag | Default | Notes |
|---|---|---|
| `--host` | `127.0.0.1` | desk-server host |
| `--port` | `35138` (env `PORT`) | desk-server port |
| `--username` | `testuser` (env `DESK_USERNAME`) | only used when auto-login is disabled |
| `--password` | `test-pass-1234` (env `DESK_PASSWORD`) | only used when auto-login is disabled |
| `--workspaces N` | `2` | fresh project workspaces created up front |
| `--scenarios-per-workspace N` | `5` | scenarios run concurrently within each workspace |
| `--scenario-budget-ms MS` | `300000` | per-scenario hard deadline |
| `--overall-budget-ms MS` | `1800000` | whole-run hard deadline; in-flight waiters resolve as `aborted` when it hits |
| `--pattern NAME` | weighted mix | repeatable; one of `quick`, `conversation`, `flood`, `attachment`, `task` |
| `--seed N` | `Date.now()` | seeds the PRNG so a run is reproducible |
| `--cleanup` | off | delete created workspaces after the run |
| `--verbose`, `-v` | off | stream per-message events to stdout |

## Patterns

| Pattern | Weight | What it stresses |
|---|---|---|
| `quick` | 4 | Baseline: one short prompt per chat. Fast happy-path measurement. |
| `conversation` | 3 | 2-3 paced messages — context retention across turns, daemon reuse. |
| `flood` | 2 | 5-10 messages back-to-back with 50-200ms gaps. Triggers the scheduler's preempt-in-flight path and stresses per-workspace serialization. |
| `attachment` | 2 | Multipart upload + file-aware prompt. 1-8 KB random text body per attachment. |
| `task` | 1 | Multi-tool prompts (LS / Read / Write). Exercises the long-running sandbox path and tool synthesis. |

Weights apply when the script picks patterns randomly. Restricting via
`--pattern X --pattern Y` makes the chosen patterns equally likely
within that subset.

## Output

### Streaming (with `--verbose`)

```
[chaos] created workspace wks_… (chaos-1731234567890-1)
[flood#3 msg 0] sent msg_aZ8Vkr…
[flood#3 msg 1] sent msg_qP2nLj…
[flood#3 msg 0] cancelled 312ms stderr=0
[flood#3 msg 1] succeeded 2847ms stderr=0
…
```

`stderr=N` is the number of `message.log_appended` events with
`kind:"stderr"` seen for that message — any non-zero value means the
chat surfaced an error to the user even if the run ultimately
succeeded.

### Per-pattern summary

```
=== chaos-test summary ===

pattern       total ok   fail cancel timeout errs stderr p50ms   p95ms
-------------------------------------------------------------------------
attachment    2     2    0    0      0       0    0      1842    2317
conversation  6     6    0    0      0       0    0      1521    2104
flood         16    10   1    5      0       0    2      842     3411
quick         12    12   0    0      0       0    0      612     1018
task          4     3    0    0      1       0    1      4203    -

total messages: 40 | ok: 33 | fail: 1 | cancel: 5 | timeout: 1 | errs: 0 | visible stderr lines: 3
wall time: 67.3s
```

Columns: `ok` = succeeded, `fail` = failed terminal state, `cancel` =
turn preempted by a later message (expected for `flood`), `timeout` =
agent reply didn't reach terminal state within the scenario budget,
`errs` = setup or send-path error (HTTP non-2xx). `stderr` = total
user-visible stderr lines across all messages in the group.

### JSONL outcomes

Each run writes `.chaos-runs/chaos-<seed>-<startMs>.jsonl` next to the
working directory. One outcome per line. Useful for diffing runs:

```bash
jq -s 'map(select(.state=="failed" or .state=="timeout"))' \
  .chaos-runs/chaos-42-1731234567890.jsonl
```

### Exit code

`failed + timeout + errs`. `0` means every message reached a terminal
non-error state. Cancellations don't count — they're the expected
outcome of the `flood` pattern.

## What "good" looks like

- `quick` and `conversation` patterns at 100% ok.
- `flood` shows roughly `ok + cancel == total` (some sends get
  preempted by later sends in the same chat — fine). `fail` /
  `timeout` on `flood` indicates a real problem.
- `attachment` at 100% ok with sub-3s p95.
- `task` at 100% ok with sub-10s p95.
- Total `visible stderr lines` = 0. Any visible stderr is by
  construction either a real model/API failure or a sandbox-layer
  failure that escaped the driver's silent-recovery loop — both worth
  investigating.

## Triaging failures

After a run that exits non-zero:

1. Filter the JSONL for terminal-bad outcomes:

   ```bash
   jq -c 'select(.state=="failed" or .state=="timeout" or .state=="setup-error" or .state=="send-error")' \
     .chaos-runs/chaos-<seed>-*.jsonl
   ```

2. Each record has `workspaceId`, `chatId`, `userMessageId`, and
   `pattern`. Cross-reference with the desk-server log to find the
   surrounding `runtime/driver` / `runtime/docker` / `scheduler/runs`
   lines for that run id.

3. Check kernel OOM events overlapping the run window:

   ```bash
   journalctl --since "$(date -u -d '5 min ago' --iso-8601=seconds)" -k \
     | grep -E "Killed process|oom-kill"
   ```

4. Check Docker port-binding errors (rootless deployments):

   ```bash
   journalctl --user-unit=docker.service --since "$(date -u -d '5 min ago' --iso-8601=seconds)" \
     | grep -E "AddPort|address already in use"
   ```

5. Compare two runs with the same seed before/after a code change —
   any regression in `ok` count or `p95ms` belongs to the change.

## When to run it

- After any change in `packages/server/runtime/` or
  `packages/server/scheduler/`.
- Before claiming a sandbox-robustness fix works.
- Periodically against a deployment to baseline drift.

Unlike `npm run test:host`, this targets a *live, running* server and
exercises the real sandbox stack — Docker, opencode-serve, the
scheduler, the WebSocket fan-out. It's slower (tens of seconds to
minutes) but catches integration regressions the unit tests can't.

## Agent prompt: run + analyze

Paste the block below into a fresh agent (Claude Code, a subagent, or
any tool with Bash + Read access to the repo). It's self-contained:
the agent doesn't need prior conversation context. Edit the
parameters at the top of the prompt to taste before sending.

```
Run the Desk chaos test and tell me exactly what broke and why. Do not
fix anything — your job is diagnosis.

## Parameters

- Repo root: /home/bero/Desk/desk-dev/Desk  (cd here first; all paths below are relative)
- Workspaces: 2
- Scenarios per workspace: 6
- Patterns: weighted default (omit --pattern flags)
- Seed: 4242  (use the same seed each time you re-run so results are comparable)
- Cleanup: yes (pass --cleanup so the workspace list doesn't grow)
- Per-scenario budget: 240000 ms
- Overall budget: 1500000 ms

## Step 1 — sanity-check the environment

Before running, verify:
1. `desk-server` is reachable: `curl -fsS http://127.0.0.1:35138/ >/dev/null && echo ok`.
   If not, STOP and report the URL/port instead of trying to start anything.
2. `docker info` succeeds (sandbox runs need it). If not, STOP and report.
3. `free -h` — note total + available memory. A host with < 1 GiB
   available will OOM-thrash and skew results; flag it before running
   so I know to discount memory-shaped failures.

## Step 2 — run the chaos test

```bash
node scripts/chaos-test.mjs \
  --workspaces 2 --scenarios-per-workspace 6 \
  --seed 4242 --cleanup \
  --scenario-budget-ms 240000 --overall-budget-ms 1500000
```

Capture both the on-screen summary AND the JSONL path it prints
(`.chaos-runs/chaos-4242-*.jsonl`).

## Step 3 — analyze outcomes

Read the JSONL with `jq`. Produce:

1. **Top-line numbers**: total messages, ok / fail / cancel / timeout /
   errs, visible stderr line count, p50 and p95 per pattern. Pull
   these straight from the printed summary; the JSONL is for drilling
   in.

2. **Bad outcomes**: list every record where
   `state in ("failed", "timeout", "setup-error", "send-error",
   "scenario-error")`. For each, include:
   - pattern, workspaceId, chatId, userMessageId, durationMs, stderrLines
   - the corresponding agent-reply messageId if present
   - the `error` field if any

3. **Cancellations on non-`flood` patterns**: cancellations on `flood`
   are expected (preemption is the whole point of that pattern).
   Cancellations on any other pattern are a real signal — list them
   separately.

4. **Stderr-positive but succeeded**: any record with `state == "succeeded"`
   and `stderrLines > 0`. These are chats that surfaced an error to
   the user even though the run eventually succeeded — likely
   recoverable failures that escaped the driver's silent-recovery
   path. Worth investigating.

## Step 4 — cross-reference logs

For each bad outcome, look for the corresponding signals:

1. **desk-server logs** (terminal where `npm run start` runs in
   `packages/server/api`, or wherever the process is writing
   stdout/stderr): grep for the runId / messageId. Pull the surrounding
   ~30 lines. The relevant modules to look for:
   `runtime/driver`, `runtime/docker`, `runtime/opencodeServer`,
   `scheduler/runs`.

2. **Kernel OOM events** during the run window:
   ```bash
   journalctl --since "$(date -u -d '<chaos-run start ISO>' --iso-8601=seconds)" \
     --until "$(date -u -d '<chaos-run end ISO>' --iso-8601=seconds)" -k \
     | grep -E "Killed process|oom-kill"
   ```
   Pair OOM-killed PIDs with their container ID (the cgroup path
   contains it) and match the container ID to a workspace via
   `docker ps -a --filter name=desk-sandbox --format '{{.ID}} {{.Names}}'`.

3. **Rootless Docker port-bind failures**:
   ```bash
   journalctl --user-unit=docker.service --since "<start>" --until "<end>" \
     | grep -E "AddPort|bind: address already in use"
   ```

4. **Sandbox container churn**: list containers whose `Created` falls
   in the run window. Unexpected recreates point at drift / port-bind
   races caught by `createOrReuse`. Run logs at log level `info` /
   `warn` from module `runtime/docker` will explain why.

## Step 5 — root-cause each issue

For each distinct failure mode (group by pattern + observed
symptom):

- one-sentence symptom
- the most specific evidence you found (log line with file:line
  reference where possible, e.g. `runtime/driver.ts:343`, kernel OOM
  details, docker error)
- which retry layer it bypassed or exhausted (engine port-bind /
  createOrReuse / acquireDaemonWithRecovery / mid-message send /
  scheduler) — use the docs in `packages/server/docs/` or the
  source in `packages/server/runtime/src/` to map symptom → layer
- whether the failure was user-visible (stderr lines surfaced) or
  silently swallowed (server log only)
- a one-line hypothesis for the root cause

## Step 6 — final report

Write a concise report (max ~600 words) with the structure:

1. **TL;DR** — one sentence on overall robustness.
2. **What passed** — patterns at 100% ok.
3. **What broke** — bullets per distinct failure mode with the
   evidence + hypothesis from Step 5.
4. **Suspected layer ownership** — which file(s) should be looked at
   to fix each, with line numbers where you have them.
5. **Anomalies worth a second look** — anything that didn't fit the
   bad-outcomes filter but looked weird (high p95 on one pattern,
   single stderr line in an otherwise-clean run, etc.).

## Boundaries

- Do NOT modify any source file.
- Do NOT restart desk-server, Docker, or any other service.
- Do NOT delete chaos-runs JSONL or any other output the user might
  want to diff later.
- If a step fails (can't reach desk-server, jq not installed,
  permission denied on journalctl), report that step's failure and
  continue with whatever else you can do. Don't bail on the whole run.
- Keep the final report under ~600 words. Detail belongs in the
  per-outcome cross-references, not the summary.
```

