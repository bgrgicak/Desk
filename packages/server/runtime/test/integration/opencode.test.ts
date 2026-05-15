/**
 * Integration test: executes trivial prompts end-to-end against the
 * single-`opencode serve`-per-sandbox runtime.
 *
 * Verifies the major contracts the rest of Desk depends on:
 *   - `driver.execRun` streams SSE-translated events as `kind: "event"`
 *     log entries whose payloads are run-format JSON (e.g. `step_start`,
 *     `text`) — this is the wire shape `scheduler/runs.ts` parses.
 *   - Two execRuns against the same sandbox keep `opencode serve` up;
 *     the second turn reuses the daemon (no double-spawn).
 *   - Session reuse across two turns of the same chat preserves the
 *     model's context (it remembers a sentinel from turn 1 in turn 2)
 *     without re-injecting it as an attachment.
 *
 * Runs automatically when Docker is available and the `desk/sandbox:v1`
 * image is present. No API key required — uses the free `opencode/big-pickle`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureLayout, ensureWorkspaceLayout } from "@agent-desk/storage";
import { createOrReuse, sandboxImage } from "../../src/docker.js";
import { createDriver, type LogEvent } from "../../src/driver.js";
import { detectEngine, type Engine } from "../../src/engine.js";
import { rmTempTree } from "./helpers.js";

let engineForSetup: Engine | null = null;
let SKIP = false;
try {
  engineForSetup = await detectEngine();
  if (!(await engineForSetup.imageId(sandboxImage()))) SKIP = true;
} catch {
  SKIP = true;
}
const describeIf = SKIP ? describe.skip : describe;

const FREE_MODEL = "opencode/big-pickle";

let home: string;
const testWorkspaceId = "wks_opencode_int_test";
const testWorkspaceSlug = "opencode-int-test";

beforeAll(async () => {
  if (SKIP) return;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-opencode-int-"));
  await ensureLayout(home);
  await ensureWorkspaceLayout(home, testWorkspaceSlug);
  process.env.DESK_HOME = home;
});

afterAll(async () => {
  if (SKIP) return;
  if (engineForSetup) {
    await engineForSetup.remove(`desk-sandbox-${testWorkspaceId}`, true).catch(() => {});
  }
  await rmTempTree(home);
});

describeIf("opencode-serve end-to-end", () => {
  it("execRun streams SSE-translated text events", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home, {});
    const driver = createDriver();
    const logs: LogEvent[] = [];

    const result = await driver.execRun(testWorkspaceId, {
      runId: "run_serve_test_1",
      prompt: "Say exactly: HELLO_DESK_TEST",
      workspaceSlug: testWorkspaceSlug,
      model: FREE_MODEL,
      providerKeys: {},
      onLog: (evt) => {
        logs.push(evt);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.opencodeSessionId).toBeTruthy();
    expect(logs.length).toBeGreaterThan(0);

    // The new driver emits all turn events as kind:"event" (SSE
    // translated to run-format JSON). Old kind:"stdout" stream from
    // `opencode run` is gone.
    const events = logs.filter((l) => l.kind === "event");
    expect(events.length, "expected event-kind log entries").toBeGreaterThan(0);

    // 1.14.50 streams a `message.part.delta` per text chunk, which we
    // translate into one `text` event per chunk. The downstream
    // concatenation in deriveTextFromLog turns those back into the
    // final message body — so the contract here is "at least one
    // text event arrived".
    const hasText = events.some((l) => l.payload.includes('"type":"text"'));
    expect(hasText, "expected at least one translated text event").toBe(true);

  }, 300_000);

  it("a second execRun in the same sandbox reuses the existing serve daemon", async () => {
    // Spawn-once is the headline perf win. We verify behaviorally: after
    // two runs we still see only one `opencode serve` process in the
    // container's process table.
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home, {});
    const driver = createDriver();

    for (const runId of ["run_serve_reuse_1", "run_serve_reuse_2"]) {
      const result = await driver.execRun(testWorkspaceId, {
        runId,
        prompt: "Reply with the single word OK.",
        workspaceSlug: testWorkspaceSlug,
        model: FREE_MODEL,
        providerKeys: {},
        onLog: () => {},
      });
      expect(result.exitCode).toBe(0);
    }

    const engine = await detectEngine();
    const processes = await engine.top(handle.containerId);
    // We spawn the bundled `.opencode` binary directly (no Node
    // wrapper script), so a healthy daemon is exactly one ps row
    // matching `*.opencode serve`. Two rows means a duplicate spawn
    // slipped past the per-container mutex.
    const daemons = processes.filter((p) => /\.opencode serve/.test(p.cmd));
    expect(
      daemons.length,
      `expected exactly one opencode-serve daemon, got ${daemons.length}: ${daemons
        .map((p) => p.cmd)
        .join(" | ")}`,
    ).toBe(1);

  }, 600_000);

  it("session reuse across two turns of the same chat preserves context", async () => {
    // The sentinel test for context-retention. Turn 1 plants a token in
    // the conversation; turn 2 must recall it without it being injected
    // again. Without session reuse this would fail — the model would
    // have no memory of turn 1.
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home, {});
    const driver = createDriver();

    const SENTINEL = "FOXTROT-9821";

    const logsOf = (kind: "first" | "second") => {
      const acc: LogEvent[] = [];
      return {
        acc,
        capture: (evt: LogEvent) => {
          acc.push(evt);
        },
        /**
         * Concatenates the `part.text` fields out of every `text`-typed
         * event in the order they arrived. With the 1.14.50 delta
         * stream this reconstructs the full assistant message text.
         */
        textOut(): string {
          let out = "";
          for (const e of acc) {
            if (e.kind !== "event") continue;
            try {
              const parsed = JSON.parse(e.payload) as { type?: string; part?: { text?: string } };
              if (parsed.type === "text" && typeof parsed.part?.text === "string") {
                out += parsed.part.text;
              }
            } catch {
              // Skip un-parseable payloads — shouldn't happen for translator output.
            }
          }
          return out;
        },
        tag: kind,
      };
    };

    const turn1 = logsOf("first");
    const r1 = await driver.execRun(testWorkspaceId, {
      runId: "run_serve_session_1",
      prompt: `Please remember this code: ${SENTINEL}. Reply: noted.`,
      workspaceSlug: testWorkspaceSlug,
      model: FREE_MODEL,
      providerKeys: {},
      onLog: turn1.capture,
    });
    expect(r1.exitCode).toBe(0);
    expect(r1.opencodeSessionId).toBeTruthy();

    const turn2 = logsOf("second");
    const r2 = await driver.execRun(testWorkspaceId, {
      runId: "run_serve_session_2",
      prompt: "What code did I just give you? Respond with the code only.",
      workspaceSlug: testWorkspaceSlug,
      model: FREE_MODEL,
      providerKeys: {},
      opencodeSessionId: r1.opencodeSessionId,
      onLog: turn2.capture,
    });
    expect(r2.exitCode).toBe(0);
    expect(r2.opencodeSessionId).toBe(r1.opencodeSessionId);

    // The second turn's text events must contain the sentinel from turn 1.
    const combined = turn2.textOut();
    expect(
      combined,
      `turn 2 must recall the turn-1 sentinel "${SENTINEL}". Got:\n${combined.slice(0, 2000)}`,
    ).toContain(SENTINEL);

  }, 600_000);

  it("cancelRun aborts a running turn", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home, {});
    const driver = createDriver();

    const runId = "run_serve_abort_1";
    const exec = driver.execRun(testWorkspaceId, {
      runId,
      prompt:
        // Ask the model for a long-form output so the turn is genuinely
        // mid-flight when we abort. We don't depend on a tool call here
        // because the free model doesn't dispatch tools for plain text.
        "Write a 500-word essay on coastal weather patterns. Take your time and use detailed paragraphs.",
      workspaceSlug: testWorkspaceSlug,
      model: FREE_MODEL,
      providerKeys: {},
      onLog: () => {},
    });

    // Give the daemon a moment to register the session before aborting,
    // otherwise the abort call hits a session that doesn't yet exist
    // server-side and the test fails for the wrong reason.
    await new Promise((r) => setTimeout(r, 1500));
    await driver.cancelRun(runId);

    const result = await exec;
    expect(
      [130, 1].includes(result.exitCode),
      `expected exit 130 or 1 after abort, got ${result.exitCode}`,
    ).toBe(true);

  }, 120_000);
});
