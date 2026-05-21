#!/usr/bin/env node
/**
 * Desk API chaos test.
 *
 * Stress-tests sandbox robustness by hammering the API directly: spins
 * up fresh project workspaces, opens many chats in parallel, fires a
 * mix of message patterns (quick questions, paced conversations,
 * preemption floods, file attachments, long multi-tool tasks), and
 * tracks every user message through to its agent reply's terminal
 * state (succeeded / failed / timeout). Prints a summary grouped by
 * pattern.
 *
 * Usage:
 *   node scripts/chaos-test.mjs                            # defaults
 *   node scripts/chaos-test.mjs --workspaces 2 --scenarios-per-workspace 5
 *   node scripts/chaos-test.mjs --pattern flood --pattern attachment
 *   node scripts/chaos-test.mjs --host 127.0.0.1 --port 35138
 *   node scripts/chaos-test.mjs --username alice --password 'pw' --cleanup
 *
 * Exit code: number of failed/timed-out messages (0 = all clean).
 *
 * Why a single file with stdlib-only fetch + the hoisted `ws`: matches
 * the repo's existing `scripts/` style (zero-install, runnable from a
 * fresh checkout), and the API is so straightforward that adding a
 * client library would be more code than the protocol itself.
 */

import { WebSocket } from "ws";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ─── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: Number(process.env.PORT ?? 35138),
    username: process.env.DESK_USERNAME ?? "testuser",
    password: process.env.DESK_PASSWORD ?? "test-pass-1234",
    workspaces: 2,
    scenariosPerWorkspace: 5,
    scenarioBudgetMs: 300_000,
    overallBudgetMs: 30 * 60_000,
    seed: Date.now(),
    cleanup: false,
    patterns: null, // null = use all weighted
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case "--host": args.host = next; i++; break;
      case "--port": args.port = Number(next); i++; break;
      case "--username": args.username = next; i++; break;
      case "--password": args.password = next; i++; break;
      case "--workspaces": args.workspaces = Number(next); i++; break;
      case "--scenarios-per-workspace": args.scenariosPerWorkspace = Number(next); i++; break;
      case "--scenario-budget-ms": args.scenarioBudgetMs = Number(next); i++; break;
      case "--overall-budget-ms": args.overallBudgetMs = Number(next); i++; break;
      case "--seed": args.seed = Number(next); i++; break;
      case "--cleanup": args.cleanup = true; break;
      case "--pattern":
        args.patterns = args.patterns ?? [];
        args.patterns.push(next); i++; break;
      case "--verbose": case "-v": args.verbose = true; break;
      case "--help": case "-h": printHelp(); process.exit(0); break;
      default:
        if (flag.startsWith("--")) {
          console.error(`unknown flag: ${flag}`);
          printHelp();
          process.exit(2);
        }
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`chaos-test — exercise the Desk API with concurrent, varied chat traffic

Flags:
  --host HOST                 (default 127.0.0.1)
  --port PORT                 (default 35138, env PORT)
  --username NAME             (default testuser, env DESK_USERNAME)
  --password PASS             (default test-pass-1234, env DESK_PASSWORD)
  --workspaces N              fresh project workspaces to create (default 2)
  --scenarios-per-workspace N (default 5)
  --scenario-budget-ms MS     per-scenario hard deadline (default 300000)
  --overall-budget-ms MS      whole-run hard deadline (default 1800000)
  --pattern NAME              repeatable; restrict to these patterns (default: weighted mix)
                              valid: quick, conversation, flood, attachment, task
  --seed N                    PRNG seed (default Date.now())
  --cleanup                   delete created workspaces after the run
  --verbose, -v               stream per-message events
`);
}

// ─── Tiny seeded PRNG so runs are reproducible ────────────────────────

function makePrng(seed) {
  // Mulberry32 — good enough for "pick a pattern, pick a sleep time".
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── HTTP client (fetch-based; no third-party deps) ───────────────────

class DeskClient {
  constructor({ host, port }) {
    this.base = `http://${host}:${port}`;
    this.token = null;
  }

  authHeaders(extra = {}) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
      ...extra,
    };
  }

  async login(username, password) {
    // Dev mode usually has DESK_AUTO_LOGIN enabled — try the
    // credential-less path first because credentials in dev rarely
    // match the seed values. Fall back to username/password when
    // auto-login is disabled (production-shaped deployments).
    const auto = await fetch(`${this.base}/auth/auto-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (auto.ok) {
      const { token } = await auto.json();
      this.token = token;
      return token;
    }
    const r = await fetch(`${this.base}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) throw new Error(`login ${r.status}: ${await r.text()}`);
    const { token } = await r.json();
    this.token = token;
    return token;
  }

  async createWorkspace({ name, description }) {
    const r = await fetch(`${this.base}/workspaces`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ name, description }),
    });
    if (!r.ok) throw new Error(`createWorkspace ${r.status}: ${await r.text()}`);
    return r.json();
  }

  async deleteWorkspace(id) {
    const r = await fetch(`${this.base}/workspaces/${id}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!r.ok) throw new Error(`deleteWorkspace ${r.status}: ${await r.text()}`);
  }

  async listAgents() {
    const r = await fetch(`${this.base}/agents`, { headers: this.authHeaders() });
    if (!r.ok) throw new Error(`listAgents ${r.status}: ${await r.text()}`);
    return r.json();
  }

  async createChat({ workspaceId, agentId, title }) {
    const r = await fetch(`${this.base}/chats`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ workspaceId, agentId, title }),
    });
    if (!r.ok) throw new Error(`createChat ${r.status}: ${await r.text()}`);
    return r.json();
  }

  async sendMessage({ chatId, content, attachments }) {
    // Plain JSON when no attachments. Multipart when we need to ship
    // file bytes — same form the app uses (mirrors the e2e test).
    if (!attachments || attachments.length === 0) {
      const r = await fetch(`${this.base}/chats/${chatId}/messages`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ content }),
      });
      if (!r.ok) throw new Error(`sendMessage ${r.status}: ${await r.text()}`);
      return r.json();
    }
    const boundary = `----desk-chaos-${crypto.randomBytes(8).toString("hex")}`;
    const chunks = [];
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n${content}\r\n`));
    for (const att of attachments) {
      const ct = att.contentType ?? "text/plain";
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${att.filename}"\r\n` +
        `Content-Type: ${ct}\r\n\r\n`,
      ));
      chunks.push(Buffer.isBuffer(att.body) ? att.body : Buffer.from(att.body));
      chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);
    const r = await fetch(`${this.base}/chats/${chatId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
    });
    if (!r.ok) throw new Error(`sendMessage(multipart) ${r.status}: ${await r.text()}`);
    return r.json();
  }

  async listMessages(chatId) {
    const r = await fetch(`${this.base}/chats/${chatId}/messages?view=timeline`, { headers: this.authHeaders() });
    if (!r.ok) throw new Error(`listMessages ${r.status}: ${await r.text()}`);
    return r.json();
  }

  openSocket() {
    return new WebSocket(`ws://${this.base.replace(/^http:\/\//, "")}/ws?token=${this.token}`);
  }
}

// ─── Event bus: route WS events to per-message waiters ────────────────

/**
 * Tracks one user message through to terminal state. Pattern:
 *   const tracker = bus.trackUserMessage(userMessageId);
 *   const outcome = await tracker.terminal(timeoutMs);  // { state, durationMs, stderrLines, agentMessageId }
 *
 * Resolves when an `agent`-role child of the user message hits a
 * terminal state (succeeded / failed / cancelled). Counts stderr lines
 * along the way so the summary can flag chats that surfaced any
 * visible error even if they eventually succeeded.
 */
class EventBus {
  constructor() {
    this.waiters = new Map(); // userMessageId -> { resolve, reject, startedAt, stderrLines, agentMessageId, timer }
    this.pendingChildren = new Map(); // chatId -> Map<parentId, agentMessageId> snapshot from message.appended
    // user msg id -> { runId, agentMessageId, terminalState, stderrLines } observed
    // BEFORE the chaos test's HTTP sendMessage returned and its tracker
    // got installed. WS event delivery races the HTTP response — without
    // this, the run's `message.updated` succeeded event can arrive before
    // the waiter exists, and the tracker times out even on the happy path.
    this.preregistered = new Map();
  }

  trackUserMessage(userMessageId, timeoutMs) {
    return new Promise((resolve) => {
      const seed = this.preregistered.get(userMessageId);
      this.preregistered.delete(userMessageId);
      const w = {
        userMessageId,
        runId: seed?.runId ?? null,
        startedAt: Date.now(),
        stderrLines: seed?.stderrLines ?? 0,
        agentMessageId: seed?.agentMessageId ?? null,
        terminal: false,
        timer: null,
      };
      // If a terminal state arrived before the tracker registered,
      // resolve immediately with the cached outcome — the chaos test
      // wasn't watching, but the run did finish.
      if (seed?.terminalState) {
        Promise.resolve().then(() => {
          if (w.terminal) return;
          w.terminal = true;
          this.waiters.delete(userMessageId);
          resolve({
            state: seed.terminalState,
            durationMs: 0,
            stderrLines: seed.stderrLines ?? 0,
            agentMessageId: seed.agentMessageId ?? null,
          });
        });
        return;
      }
      w.timer = setTimeout(() => {
        if (w.terminal) return;
        w.terminal = true;
        this.waiters.delete(userMessageId);
        resolve({
          state: "timeout",
          durationMs: Date.now() - w.startedAt,
          stderrLines: w.stderrLines,
          agentMessageId: w.agentMessageId,
        });
      }, timeoutMs);
      w.resolve = (outcome) => {
        if (w.terminal) return;
        w.terminal = true;
        clearTimeout(w.timer);
        this.waiters.delete(userMessageId);
        resolve({ ...outcome, durationMs: Date.now() - w.startedAt });
      };
      this.waiters.set(userMessageId, w);
    });
  }

  // Look up either an active waiter or a pre-registration seed by any
  // of the three ids in the user→system→agent chain. Returns one of
  // the two collection records (or null) so callers can mutate.
  _findEither(id) {
    for (const w of this.waiters.values()) {
      if (w.userMessageId === id || w.runId === id || w.agentMessageId === id) return w;
    }
    for (const [userId, seed] of this.preregistered) {
      if (userId === id || seed.runId === id || seed.agentMessageId === id) return seed;
    }
    return null;
  }

  // Pre-register a runId/agentMessageId/etc keyed by user message id,
  // so a tracker that registers AFTER the WS event has fired can still
  // pick up the outcome.
  _preregister(userMessageId, patch) {
    const cur = this.preregistered.get(userMessageId) ?? {
      runId: null,
      agentMessageId: null,
      terminalState: null,
      stderrLines: 0,
    };
    this.preregistered.set(userMessageId, { ...cur, ...patch });
  }

  ingest(event) {
    const t = event.type;
    if (t === "message.appended") {
      const m = event.payload;
      // The data model is user -> system (scheduler's "run" wrapper)
      // -> agent. We learn the runId from the system row appearing
      // with parentId === userMessageId, and the agentMessageId from
      // an agent row appearing with parentId === runId.
      if (m.role === "system" && m.parentId) {
        const w = this.waiters.get(m.parentId);
        if (w) { w.runId = m.id; return; }
        this._preregister(m.parentId, { runId: m.id });
        return;
      }
      if (m.role === "agent" && m.parentId) {
        // parent is the system run; find by runId among waiters
        // first, then among preregistered seeds.
        for (const w of this.waiters.values()) {
          if (w.runId === m.parentId) { w.agentMessageId = m.id; return; }
        }
        for (const [userId, seed] of this.preregistered) {
          if (seed.runId === m.parentId) {
            this._preregister(userId, { agentMessageId: m.id });
            return;
          }
        }
      }
      return;
    }
    if (t === "message.updated") {
      const m = event.payload;
      if (!(m.state === "succeeded" || m.state === "failed" || m.state === "cancelled")) {
        return;
      }
      // Live waiter wins. Otherwise stash the terminal state on
      // the pre-registration so trackUserMessage can pick it up.
      for (const w of this.waiters.values()) {
        if (w.userMessageId === m.id || w.runId === m.id || w.agentMessageId === m.id) {
          w.resolve({ state: m.state, stderrLines: w.stderrLines, agentMessageId: w.agentMessageId ?? m.id });
          return;
        }
      }
      for (const [userId, seed] of this.preregistered) {
        if (userId === m.id || seed.runId === m.id || seed.agentMessageId === m.id) {
          this._preregister(userId, { terminalState: m.state });
          return;
        }
      }
      return;
    }
    if (t === "message.log_appended") {
      const { messageId, kind } = event.payload;
      if (kind !== "stderr") return;
      const rec = this._findEither(messageId);
      if (rec) rec.stderrLines = (rec.stderrLines ?? 0) + 1;
    }
  }

  // Resolve every pending waiter as `aborted` — used on overall budget exhaustion.
  abortAll() {
    for (const w of this.waiters.values()) {
      w.resolve?.({ state: "aborted", stderrLines: w.stderrLines, agentMessageId: w.agentMessageId });
    }
  }
}

// ─── Patterns ─────────────────────────────────────────────────────────

/**
 * Each pattern produces a sequence of `{ content, attachments?, sleepAfterMs }`
 * entries. The scenario runner sends them in order, waiting
 * `sleepAfterMs` between sends. A scenario only ends when every user
 * message has reached a terminal state (or the budget runs out).
 *
 * The "task" pattern intentionally requests multi-tool work to stress
 * the long-running sandbox path. The "flood" pattern sends faster than
 * the scheduler can serialize turns — exercises preemption of the
 * prior in-flight turn (see `2e0823d sandbox: drop unused session
 * destructure on /sandbox/messages` / `7724a02 scheduler: prevent
 * duplicate child after preempted chat turn`).
 */
const PATTERNS = {
  quick: {
    weight: 4,
    build: (rng, ctx) => [{
      content: pick(rng, [
        "What is 2 + 2?",
        "Reply with exactly one word: ack",
        "Say the word 'pineapple' and nothing else.",
        "How many letters are in the word 'sandbox'?",
      ]),
    }],
  },
  conversation: {
    weight: 3,
    build: (rng, ctx) => {
      const turns = 2 + Math.floor(rng() * 2); // 2 or 3
      const lines = [
        "Hi! Quick question coming up.",
        "What's the capital of France?",
        "Now what's the capital of Japan?",
        "Thanks, that's all for now.",
      ];
      return Array.from({ length: turns }, (_, i) => ({
        content: lines[i] ?? `Follow-up question ${i + 1}: are you still there?`,
        sleepAfterMs: 1500 + Math.floor(rng() * 1500),
      }));
    },
  },
  flood: {
    weight: 2,
    build: (rng, ctx) => {
      const n = 5 + Math.floor(rng() * 6); // 5..10
      return Array.from({ length: n }, (_, i) => ({
        content: `Rapid message ${i + 1}/${n}: reply with a single digit.`,
        // Fire faster than turns can complete — exercises the
        // scheduler's preempt-in-flight path.
        sleepAfterMs: 50 + Math.floor(rng() * 150),
      }));
    },
  },
  attachment: {
    weight: 2,
    build: (rng, ctx) => {
      const sizeKb = 1 + Math.floor(rng() * 8); // 1..8 KB
      const filename = `chaos-${ctx.scenarioId}-${Date.now()}.txt`;
      const body = Buffer.from(
        Array.from({ length: sizeKb * 1024 }, (_, i) =>
          String.fromCharCode(32 + ((i * 7) % 90)),
        ).join(""),
      );
      return [{
        content: `Please summarise this attached file in one sentence (filename: ${filename}).`,
        attachments: [{ filename, contentType: "text/plain", body }],
      }];
    },
  },
  task: {
    weight: 1,
    build: (rng, ctx) => {
      const prompts = [
        "List up to 5 files in the workspace root and report their names and sizes.",
        "Check whether this workspace contains a package.json. If yes, print its name and version.",
        "Write the string 'CHAOS_OK' to a new file named chaos-output.txt and confirm.",
        "Count the number of files in the workspace root. Report the count.",
      ];
      return [{ content: pick(rng, prompts) }];
    },
  },
};

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function pickPattern(rng, allowed) {
  const names = allowed ?? Object.keys(PATTERNS);
  const weighted = [];
  for (const n of names) {
    const p = PATTERNS[n];
    if (!p) throw new Error(`unknown pattern: ${n}`);
    for (let i = 0; i < p.weight; i++) weighted.push(n);
  }
  return weighted[Math.floor(rng() * weighted.length)];
}

// ─── Scenario runner ──────────────────────────────────────────────────

/**
 * One scenario = one fresh chat + a pattern's message sequence. Sends
 * each message, awaits its terminal state, and collects per-message
 * outcomes. Returns an array of outcome records for the summary.
 *
 * The terminal-state await is per-message (not per-scenario) so flood
 * scenarios get accurate timing for every send — even ones the
 * scheduler preempts. A preempted turn arrives as state=cancelled,
 * which we count as a distinct outcome (neither pass nor fail).
 */
async function runScenario({
  client, bus, workspace, agentId, scenarioId, pattern, rng, budgetMs, verbose,
}) {
  const startedAt = Date.now();
  const outcomes = [];
  let chat;
  try {
    chat = await client.createChat({
      workspaceId: workspace.id,
      agentId,
      title: `chaos-${pattern}-${scenarioId}`,
    });
  } catch (err) {
    return [{
      scenarioId, pattern, workspaceId: workspace.id, chatId: null,
      state: "setup-error",
      durationMs: Date.now() - startedAt,
      error: err.message,
    }];
  }

  const ctx = { scenarioId, chatId: chat.id };
  const messages = PATTERNS[pattern].build(rng, ctx);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const remainingBudget = budgetMs - (Date.now() - startedAt);
    if (remainingBudget <= 1000) {
      outcomes.push({
        scenarioId, pattern, workspaceId: workspace.id, chatId: chat.id,
        messageIndex: i, state: "scenario-budget-exhausted", durationMs: 0,
      });
      continue;
    }
    let userMsg;
    try {
      userMsg = await client.sendMessage({
        chatId: chat.id,
        content: m.content,
        attachments: m.attachments,
      });
    } catch (err) {
      outcomes.push({
        scenarioId, pattern, workspaceId: workspace.id, chatId: chat.id,
        messageIndex: i, state: "send-error", durationMs: 0, error: err.message,
      });
      continue;
    }
    if (verbose) {
      process.stdout.write(`[${pattern}#${scenarioId} msg ${i}] sent ${userMsg.id}\n`);
    }
    const tracker = bus.trackUserMessage(userMsg.id, Math.min(remainingBudget, budgetMs));
    if (m.sleepAfterMs && i < messages.length - 1) {
      // Pace the NEXT send. Don't await this message — that's the
      // whole point of flood: stack POSTs faster than the scheduler
      // can drain.
      await sleep(m.sleepAfterMs);
    }
    const outcome = await tracker;
    outcomes.push({
      scenarioId, pattern, workspaceId: workspace.id, chatId: chat.id,
      messageIndex: i, userMessageId: userMsg.id,
      ...outcome,
    });
    if (verbose) {
      process.stdout.write(
        `[${pattern}#${scenarioId} msg ${i}] ${outcome.state} ` +
        `${outcome.durationMs}ms stderr=${outcome.stderrLines}\n`,
      );
    }
  }
  return outcomes;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Reporting ────────────────────────────────────────────────────────

function summarise(outcomes) {
  // Group by pattern; compute success/fail/timeout/cancelled counts +
  // p50/p95 durations + total stderr-line count.
  const byPattern = new Map();
  for (const o of outcomes) {
    let g = byPattern.get(o.pattern);
    if (!g) {
      g = {
        pattern: o.pattern, total: 0,
        succeeded: 0, failed: 0, cancelled: 0, timeout: 0, aborted: 0,
        errors: 0, durations: [], stderrLines: 0,
      };
      byPattern.set(o.pattern, g);
    }
    g.total++;
    if (o.state === "succeeded") g.succeeded++;
    else if (o.state === "failed") g.failed++;
    else if (o.state === "cancelled") g.cancelled++;
    else if (o.state === "timeout") g.timeout++;
    else if (o.state === "aborted") g.aborted++;
    else g.errors++;
    if (typeof o.durationMs === "number") g.durations.push(o.durationMs);
    if (typeof o.stderrLines === "number") g.stderrLines += o.stderrLines;
  }
  return Array.from(byPattern.values()).sort((a, b) => a.pattern.localeCompare(b.pattern));
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[i];
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printSummary(groups, outcomes, walltimeMs) {
  process.stdout.write("\n=== chaos-test summary ===\n\n");
  const cols = ["pattern", "total", "ok", "fail", "cancel", "timeout", "errs", "stderr", "p50ms", "p95ms"];
  const widths = [14, 6, 5, 5, 7, 8, 5, 7, 8, 8];
  let header = "";
  for (let i = 0; i < cols.length; i++) header += pad(cols[i], widths[i]);
  process.stdout.write(header + "\n");
  process.stdout.write("-".repeat(header.length) + "\n");
  for (const g of groups) {
    const sorted = [...g.durations].sort((a, b) => a - b);
    const p50 = quantile(sorted, 0.5);
    const p95 = quantile(sorted, 0.95);
    const row = [
      g.pattern, g.total, g.succeeded, g.failed, g.cancelled, g.timeout, g.errors,
      g.stderrLines, p50 ?? "-", p95 ?? "-",
    ];
    let line = "";
    for (let i = 0; i < row.length; i++) line += pad(row[i], widths[i]);
    process.stdout.write(line + "\n");
  }
  const totals = groups.reduce((a, g) => ({
    total: a.total + g.total,
    succeeded: a.succeeded + g.succeeded,
    failed: a.failed + g.failed,
    cancelled: a.cancelled + g.cancelled,
    timeout: a.timeout + g.timeout,
    errors: a.errors + g.errors,
    stderr: a.stderr + g.stderrLines,
  }), { total: 0, succeeded: 0, failed: 0, cancelled: 0, timeout: 0, errors: 0, stderr: 0 });
  process.stdout.write("\n");
  process.stdout.write(
    `total messages: ${totals.total} | ok: ${totals.succeeded} | fail: ${totals.failed} | ` +
    `cancel: ${totals.cancelled} | timeout: ${totals.timeout} | errs: ${totals.errors} | ` +
    `visible stderr lines: ${totals.stderr}\n`,
  );
  process.stdout.write(`wall time: ${(walltimeMs / 1000).toFixed(1)}s\n`);
  return totals.failed + totals.timeout + totals.errors;
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.stdout.write(`[chaos] target=http://${args.host}:${args.port} ` +
    `workspaces=${args.workspaces} scenarios/workspace=${args.scenariosPerWorkspace} ` +
    `seed=${args.seed}\n`);

  const client = new DeskClient({ host: args.host, port: args.port });
  const rng = makePrng(args.seed);

  // 1. Auth
  try {
    await client.login(args.username, args.password);
  } catch (err) {
    process.stderr.write(`[chaos] login failed: ${err.message}\n`);
    process.exit(1);
  }

  // 2. Pick an agent (any owned agent works as the workspace default).
  const agents = await client.listAgents();
  if (!agents.length) {
    process.stderr.write(`[chaos] no agents available for ${args.username}\n`);
    process.exit(1);
  }
  const agent = agents[0];

  // 3. Provision workspaces
  const workspaces = [];
  for (let i = 0; i < args.workspaces; i++) {
    const ws = await client.createWorkspace({
      name: `chaos-${args.seed}-${i + 1}`,
      description: `Chaos test workspace (seed ${args.seed})`,
    });
    workspaces.push(ws);
    process.stdout.write(`[chaos] created workspace ${ws.id} (${ws.name})\n`);
  }

  // 4. Open WebSocket; route every event into the bus.
  const bus = new EventBus();
  const sock = client.openSocket();
  await new Promise((resolve, reject) => {
    sock.once("open", resolve);
    sock.once("error", reject);
  });
  sock.on("message", (raw) => {
    let event;
    try { event = JSON.parse(raw.toString()); }
    catch { return; }
    bus.ingest(event);
  });
  sock.on("close", () => {
    if (args.verbose) process.stdout.write(`[chaos] WebSocket closed\n`);
  });

  // 5. Launch scenarios concurrently.
  const startedAt = Date.now();
  const overallDeadline = startedAt + args.overallBudgetMs;
  const tasks = [];
  let scenarioId = 0;
  for (const ws of workspaces) {
    for (let i = 0; i < args.scenariosPerWorkspace; i++) {
      const pattern = pickPattern(rng, args.patterns);
      const id = ++scenarioId;
      tasks.push(
        runScenario({
          client, bus, workspace: ws, agentId: agent.id,
          scenarioId: id, pattern, rng,
          budgetMs: Math.min(args.scenarioBudgetMs, overallDeadline - Date.now()),
          verbose: args.verbose,
        }).catch((err) => [{
          scenarioId: id, pattern, workspaceId: ws.id, chatId: null,
          state: "scenario-error", durationMs: 0, error: err.message,
        }]),
      );
    }
  }

  // Overall budget — abort any straggling waiters when it elapses so
  // the script exits even if something hangs at a layer below the
  // scheduler's retry. The summary still includes them as "aborted".
  const overallTimer = setTimeout(() => {
    process.stderr.write(`[chaos] overall budget reached; aborting in-flight waiters\n`);
    bus.abortAll();
  }, args.overallBudgetMs);
  overallTimer.unref?.();

  const resultsNested = await Promise.all(tasks);
  clearTimeout(overallTimer);
  const outcomes = resultsNested.flat();

  // 6. Print summary + decide exit code.
  const groups = summarise(outcomes);
  const failureCount = printSummary(groups, outcomes, Date.now() - startedAt);

  // 7. Optional cleanup
  sock.close();
  if (args.cleanup) {
    for (const ws of workspaces) {
      try {
        await client.deleteWorkspace(ws.id);
        process.stdout.write(`[chaos] deleted workspace ${ws.id}\n`);
      } catch (err) {
        process.stderr.write(`[chaos] cleanup failed for ${ws.id}: ${err.message}\n`);
      }
    }
  } else {
    process.stdout.write(`[chaos] workspaces left in place for post-mortem ` +
      `(pass --cleanup to delete): ${workspaces.map((w) => w.id).join(", ")}\n`);
  }

  // Also dump per-outcome JSONL to a file alongside the script so a
  // later run can diff what changed. Names embed the seed so two runs
  // don't overwrite each other.
  const outDir = path.join(process.cwd(), ".chaos-runs");
  try { await fs.mkdir(outDir, { recursive: true }); } catch {}
  const outPath = path.join(outDir, `chaos-${args.seed}-${startedAt}.jsonl`);
  await fs.writeFile(outPath, outcomes.map((o) => JSON.stringify(o)).join("\n") + "\n");
  process.stdout.write(`[chaos] outcomes written to ${outPath}\n`);

  process.exit(failureCount);
}

main().catch((err) => {
  process.stderr.write(`[chaos] fatal: ${err.stack ?? err.message ?? err}\n`);
  process.exit(2);
});
