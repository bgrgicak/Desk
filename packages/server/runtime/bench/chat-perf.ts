// Measures the wall-clock cost of reusing an opencode-serve session
// across turns vs. creating a fresh one per turn, plus a microbench of
// the bare POST /session HTTP overhead so we can attribute any per-turn
// delta to either "session creation" or "context replay".
//
// Run from repo root: npx tsx packages/server/runtime/bench/chat-perf.ts
// Needs Docker + the desk/sandbox:v1 image. Uses opencode/big-pickle
// (free, no API key).
//
// console.* is intentional in this one-off CLI benchmark — operators
// run it ad-hoc and expect plain stdout, not structured JSON.
/* eslint-disable no-console */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureLayout, ensureWorkspaceLayout } from "@agent-desk/storage";
import { createOrReuse, sandboxUser } from "../src/docker.js";
import { createDriver } from "../src/driver.js";
import { detectEngine } from "../src/engine.js";
import { ensureOpencodeServer } from "../src/opencodeServer.js";
import { OpencodeClient } from "../src/opencodeClient.js";
import { SANDBOX_HOME } from "../src/mounts.js";

const MODEL = "opencode/big-pickle";

// Ten short turns that build on each other. Brief responses keep
// generation-time noise low so the timing reflects daemon/round-trip
// + context-replay cost rather than how chatty the model decided to be.
const TURNS = [
  "I'm sketching a tiny TypeScript calculator module. Reply only: OK.",
  "Suggest a name for the first function (e.g. add). One word.",
  "Now the second function. One word.",
  "Now the third. One word.",
  "Now the fourth. One word.",
  "What's a good file name for the module? One word, no extension.",
  "What's one edge case we should test? One sentence.",
  "What's a second edge case? One sentence.",
  "What's a third edge case? One sentence.",
  "List the four function names you proposed, comma-separated.",
];

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(0).padStart(7)} ms`;
}

function stats(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    total: sum,
    mean: sum / sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    n: sorted.length,
  };
}

function printStats(label: string, times: number[]) {
  const s = stats(times);
  console.log(
    `${label.padEnd(22)} n=${s.n}  total=${fmtMs(s.total)}  mean=${fmtMs(s.mean)}  p50=${fmtMs(s.p50)}  p95=${fmtMs(s.p95)}`,
  );
}

async function main() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-perf-"));
  await ensureLayout(home);
  const slug = "perf-bench";
  await ensureWorkspaceLayout(home, slug);
  process.env.DESK_HOME = home;

  const workspaceId = "wks_perf_bench";
  const driver = createDriver();
  const engine = await detectEngine();

  console.log(`bench: home=${home} workspace=${slug} model=${MODEL}`);
  console.log(`booting sandbox + spawning opencode-serve (cold) ...`);

  const handle = await createOrReuse(workspaceId, slug, home, {});

  // Warm-up turn so the first measured turn isn't dominated by daemon
  // cold-start. Discarded from the reported numbers.
  const warmStart = performance.now();
  const warm = await driver.execRun(workspaceId, {
    runId: "warm",
    prompt: "Reply OK.",
    workspaceSlug: slug,
    model: MODEL,
    providerKeys: {},
    onLog: () => {},
  });
  const warmMs = performance.now() - warmStart;
  if (warm.exitCode !== 0) {
    throw new Error(`warm-up turn failed (exit ${warm.exitCode})`);
  }
  console.log(`warm-up: ${fmtMs(warmMs)} (this includes daemon cold-start)`);

  // ---- Microbench: bare POST /session round-trip ----
  // Reuse the already-spawned daemon. ensureOpencodeServer is idempotent
  // and returns the same cached instance under the same env digest.
  const user = await sandboxUser(engine);
  const server = await ensureOpencodeServer(engine, {
    containerId: handle.containerId,
    cwd: SANDBOX_HOME,
    user,
    env: {},
  });
  const client = new OpencodeClient(server.url, server.password);

  console.log(`\n[microbench] POST /session x 30 (no model call)`);
  const createTimes: number[] = [];
  const createdIds: string[] = [];
  for (let i = 0; i < 30; i++) {
    const { ms, value } = await timed(() => client.createSession());
    createTimes.push(ms);
    createdIds.push(value.id);
  }
  printStats("create session", createTimes);
  for (const id of createdIds) {
    await client.deleteSession(id).catch(() => {});
  }

  // ---- Multi-turn: reused session ----
  console.log(`\n[multi-turn] reused session, ${TURNS.length} turns`);
  const reusedTimes: number[] = [];
  let reusedSession: string | undefined = undefined;
  for (let i = 0; i < TURNS.length; i++) {
    const { ms, value } = await timed(() =>
      driver.execRun(workspaceId, {
        runId: `reused_${i}`,
        prompt: TURNS[i],
        workspaceSlug: slug,
        model: MODEL,
        providerKeys: {},
        opencodeSessionId: reusedSession,
        onLog: () => {},
      }),
    );
    if (value.exitCode !== 0) {
      console.warn(`  turn ${i}: exit ${value.exitCode}`);
    }
    reusedSession = value.opencodeSessionId ?? reusedSession;
    reusedTimes.push(ms);
    console.log(`  turn ${i.toString().padStart(2)}: ${fmtMs(ms)}`);
  }
  printStats("reused", reusedTimes);

  // ---- Multi-turn: fresh session every turn ----
  console.log(`\n[multi-turn] fresh session per turn, ${TURNS.length} turns`);
  const freshTimes: number[] = [];
  for (let i = 0; i < TURNS.length; i++) {
    const { ms, value } = await timed(() =>
      driver.execRun(workspaceId, {
        runId: `fresh_${i}`,
        prompt: TURNS[i],
        workspaceSlug: slug,
        model: MODEL,
        providerKeys: {},
        opencodeSessionId: null,
        onLog: () => {},
      }),
    );
    if (value.exitCode !== 0) {
      console.warn(`  turn ${i}: exit ${value.exitCode}`);
    }
    freshTimes.push(ms);
    console.log(`  turn ${i.toString().padStart(2)}: ${fmtMs(ms)}`);
  }
  printStats("fresh", freshTimes);

  // ---- Side-by-side ----
  console.log(`\n[per-turn comparison]`);
  console.log(`  turn |   reused    |    fresh    |  delta`);
  for (let i = 0; i < TURNS.length; i++) {
    const r = reusedTimes[i];
    const f = freshTimes[i];
    const delta = f - r;
    const sign = delta >= 0 ? "+" : "";
    console.log(
      `  ${i.toString().padStart(4)} | ${fmtMs(r)} | ${fmtMs(f)} |  ${sign}${delta.toFixed(0)} ms`,
    );
  }

  const reusedS = stats(reusedTimes);
  const freshS = stats(freshTimes);
  console.log(
    `\n  totals  reused=${(reusedS.total / 1000).toFixed(2)}s  fresh=${(freshS.total / 1000).toFixed(2)}s  delta=${((freshS.total - reusedS.total) / 1000).toFixed(2)}s`,
  );

  // ---- Teardown ----
  await engine.remove(`desk-sandbox-${workspaceId}`, true).catch(() => {});
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  console.log(`\ndone.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
