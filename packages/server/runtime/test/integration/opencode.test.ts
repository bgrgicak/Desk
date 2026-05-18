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
 *   - Switching the agent's `model:` field on disk does NOT change which
 *     model the daemon uses until the daemon is restarted — the host
 *     side must `restartOpencodeServer` after a model change for the
 *     new model to take effect.
 *
 * Runs automatically when Docker is available and the `desk/sandbox:v1`
 * image is present. No API key required — uses the free `opencode/big-pickle`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureLayout, ensureWorkspaceLayout } from "@agent-desk/storage";
import { createOrReuse, sandboxImage, sandboxUser } from "../../src/docker.js";
import { createDriver, type LogEvent } from "../../src/driver.js";
import { detectEngine, type Engine } from "../../src/engine.js";
import {
  ensureOpencodeServer,
  invalidateOpencodeServerCache,
  restartOpencodeServer,
} from "../../src/opencodeServer.js";
import { OpencodeClient } from "../../src/opencodeClient.js";
import { SANDBOX_HOME } from "../../src/mounts.js";
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
    // The model-switching test uses a dedicated workspace/container
    // (see test body) so its lifecycle isn't entangled with the
    // shared suite container.
    await engineForSetup.remove(`desk-sandbox-wks_modelswitch_int_test`, true).catch(() => {});
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

  it("tool calls show up as `tool`/`step_*` events in the run's log stream", async () => {
    // Regression coverage for the PR #111 architecture flip. The old
    // dispatch (`opencode run`) printed every tool call to stdout, so the
    // runtime piped it straight into the message's event log. The new
    // long-lived `opencode serve` only broadcasts text/reasoning deltas
    // over SSE — tool/step parts must be pulled back via `GET
    // /session/:id/message` after the turn settles, and `driver.execRun`
    // must synthesize them into the `onLog` stream. Without this, the UI
    // can't render a tool card and the chat history loses provenance for
    // anything the model did with tools.
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home, {});
    const driver = createDriver();

    const events: Array<{ type?: string }> = [];
    const result = await driver.execRun(testWorkspaceId, {
      runId: "run_serve_tool_synth",
      prompt:
        // Force a bash tool call. The free model occasionally answers
        // from memory, but giving it a one-off shell hint pushes it to
        // dispatch — confirmed during local development. The test only
        // asserts the bookkeeping path, not which tool the model picks.
        "Use the `bash` tool to run `echo TOOL_SYNTH_PROBE` and then tell me the output.",
      workspaceSlug: testWorkspaceSlug,
      model: FREE_MODEL,
      providerKeys: {},
      onLog: (evt) => {
        if (evt.kind !== "event") return;
        try {
          events.push(JSON.parse(evt.payload) as { type?: string });
        } catch {
          // Translator output is always JSON; a parse error means the
          // shape changed.
        }
      },
    });

    expect(result.exitCode).toBe(0);

    const nonTextTypes = events
      .map((e) => e.type)
      .filter((t): t is string => typeof t === "string" && t !== "text" && t !== "reasoning");
    expect(
      nonTextTypes.length,
      `expected ≥1 tool/step event from the synthesized turn, got: ${nonTextTypes.join(",") || "none"}`,
    ).toBeGreaterThan(0);
    // Specifically — step boundaries must appear. They mark turn
    // segments and the UI uses them to fold tool clusters.
    expect(nonTextTypes).toContain("step_finish");
  }, 600_000);

  it("switching the agent's model in-place only takes effect after the daemon restarts", async () => {
    // Regression coverage for the model-switching bug.
    //
    // opencode-serve 1.14.50 reads each agent file's `model:` field into
    // an in-memory `agent.<id>.model` cache at daemon startup and never
    // re-reads it on the hot path. It also ignores per-message
    // `providerID`/`modelID` overrides for sessions that bind an agent.
    // So rewriting the agent file with a new model is invisible to a
    // running daemon — every subsequent sendMessage keeps using the
    // model the daemon cached at startup, even on a brand-new session.
    //
    // The user-visible symptom: pick a new model in Settings, send a
    // turn, and the assistant's step_start/step_finish events still
    // carry the OLD modelID. Desk's fix is to restart the daemon when
    // an agent's model changes (the `refreshSandboxConnections` path
    // PATCH /agents/:id triggers). This test pins that contract end-
    // to-end against a real sandbox and a real opencode-serve.
    //
    // We probe the daemon directly via OpencodeClient rather than
    // going through `driver.execRun`. The driver wraps every call in
    // SSE-subscription + message-polling + tool-synthesis logic that
    // adds minutes to an already-slow free-model turn — and we don't
    // need any of it: opencode-serve commits each session's resolved
    // `model` into `/config` (and into `GET /session/:id`) as soon as
    // the session is created, before the model even starts streaming.
    // So we read those endpoints directly and never wait for the LLM
    // to finish a reply.
    //
    // Use a dedicated workspace/container so we control the daemon's
    // lifecycle deterministically.
    const switchWorkspaceId = "wks_modelswitch_int_test";
    const switchWorkspaceSlug = "modelswitch-int-test";
    await ensureWorkspaceLayout(home, switchWorkspaceSlug);
    const engine = await detectEngine();
    // Self-heal: remove any leftover container with this name before
    // createOrReuse decides to reuse one. A leftover can survive
    // across test runs when the desk-server's idle-sandbox sweeper
    // reaps our test container (it doesn't know about test
    // workspaces). createOrReuse's reuse path would then return that
    // stale handle and `engine.port` fails because the mapping is
    // gone. Removing first is cheaper than fighting it.
    await engine.remove(`desk-sandbox-${switchWorkspaceId}`, true).catch(() => {});
    const handle = await createOrReuse(switchWorkspaceId, switchWorkspaceSlug, home, {});
    const user = await sandboxUser(engine);

    const agentId = "agt_modelswitch_test";
    const MODEL_A_RAW = "opencode/big-pickle";
    const MODEL_B_RAW = "opencode/qwen3.6-plus-free";
    const MODEL_A_ID = "big-pickle";
    const MODEL_B_ID = "qwen3.6-plus-free";

    const writeAgent = async (model: string) => {
      const { workspaceRootPath } = await import("@agent-desk/storage");
      const agentDir = path.join(workspaceRootPath(home, switchWorkspaceSlug), ".opencode", "agents");
      await fs.mkdir(agentDir, { recursive: true });
      const body = `---
description: ModelSwitchTest
model: ${model}
mode: primary
permission:
  read: allow
  edit: allow
  bash: allow
---

Reply with exactly: SWITCH_OK
`;
      await fs.writeFile(path.join(agentDir, `${agentId}.md`), body, "utf-8");
    };

    // Read the daemon's resolved model for our agent from the
    // `/config` endpoint. That's where opencode-serve exposes the
    // exact (providerID/modelID) it loaded for each agent at startup —
    // the same field that, mid-life, refuses to update.
    const fetchAgentModelFromConfig = async (): Promise<string | null> => {
      const credentials = Buffer.from(`opencode:${client.password}`).toString("base64");
      const r = await fetch(`${client.url}/config`, {
        headers: { Authorization: `Basic ${credentials}` },
      });
      if (!r.ok) throw new Error(`GET /config returned ${r.status}`);
      const config = (await r.json()) as {
        agent?: Record<string, { model?: unknown }>;
      };
      const entry = config.agent?.[agentId];
      if (!entry || typeof entry.model !== "string") return null;
      // `model:` is stored verbatim ("opencode/big-pickle"); strip the
      // provider prefix so the assertions read naturally next to the
      // bare model id you'd see in `step_*` events.
      const slash = entry.model.indexOf("/");
      return slash >= 0 ? entry.model.slice(slash + 1) : entry.model;
    };

    // -- Setup the daemon with MODEL_A baked into the agent file ---

    await writeAgent(MODEL_A_RAW);
    const server = await ensureOpencodeServer(engine, {
      containerId: handle.containerId,
      cwd: SANDBOX_HOME,
      user,
      env: {},
    });
    let client = new OpencodeClient(server.url, server.password);

    // -- Probe 1: daemon's cache should reflect MODEL_A ------------

    expect(
      await fetchAgentModelFromConfig(),
      "first daemon spawn must load MODEL_A from the agent file",
    ).toBe(MODEL_A_ID);

    // -- Rewrite to MODEL_B without restarting the daemon ----------

    await writeAgent(MODEL_B_RAW);

    // The bug: the daemon's cache MUST still report MODEL_A. If a
    // future opencode-serve release watches the agents directory and
    // hot-reloads on file changes, this assertion flips — at which
    // point Desk's daemon-restart-on-model-change is redundant and
    // should be revisited.
    expect(
      await fetchAgentModelFromConfig(),
      "after rewriting the agent file without restarting, the daemon must still report MODEL_A — this is the bug Desk's restart works around",
    ).toBe(MODEL_A_ID);

    // -- The production fix: restart the daemon --------------------

    invalidateOpencodeServerCache(handle.containerId);
    const server2 = await restartOpencodeServer(engine, {
      containerId: handle.containerId,
      cwd: SANDBOX_HOME,
      user,
      env: {},
    });
    client = new OpencodeClient(server2.url, server2.password);

    // -- Probe 2: daemon's cache should now reflect MODEL_B --------

    expect(
      await fetchAgentModelFromConfig(),
      "after restartOpencodeServer the daemon must load MODEL_B from the rewritten agent file",
    ).toBe(MODEL_B_ID);

  }, 120_000);

  it("a fresh daemon spawn wipes the persistent auth store so disabled providers stop authing", async () => {
    // Regression coverage for the "I disabled Codex but the chat keeps
    // using it" leak.
    //
    // opencode-serve persists every `PUT /auth/<provider>` registration
    // in `~/.local/share/opencode/auth.json` and reloads that file on
    // startup. Without an explicit wipe at spawn time, an OAuth blob
    // registered during a previous spawn (when Codex was enabled)
    // keeps authenticating the openai provider after the user disables
    // Codex — even when the new spawn's env has zero credentials.
    //
    // The Desk fix wipes the persistent auth file at the start of
    // every `startOpencodeServer` and lets `registerAuthBlobs` re-PUT
    // only what the CURRENT env contains. This scales to N providers
    // (one filesystem op regardless of count) and keeps the daemon's
    // auth surface in lockstep with Settings.
    //
    // We assert end-to-end: spawn a daemon WITH an OAuth blob in env,
    // verify the openai provider becomes `custom`-sourced (i.e. auth
    // was PUT into the daemon), then re-spawn the daemon WITHOUT the
    // blob and verify the openai provider's auth is gone.
    const authWipeWorkspaceId = "wks_authwipe_int_test";
    const authWipeWorkspaceSlug = "authwipe-int-test";
    await ensureWorkspaceLayout(home, authWipeWorkspaceSlug);
    const engine = await detectEngine();
    // Self-heal — see the model-switching test for the rationale.
    await engine.remove(`desk-sandbox-${authWipeWorkspaceId}`, true).catch(() => {});
    const handle = await createOrReuse(authWipeWorkspaceId, authWipeWorkspaceSlug, home, {});
    const user = await sandboxUser(engine);

    // Build a plausible-looking OAuth blob the way our Codex bridge
    // would. The shape must match what `registerAuthBlobs` accepts —
    // any other shape is silently skipped, which would let this test
    // pass for the wrong reason.
    const oauthBlob = JSON.stringify({
      openai: {
        type: "oauth",
        refresh: "fake-refresh",
        access: "fake-access",
        expires: Date.now() + 60 * 60 * 1000,
        accountId: "fake-account",
      },
    });

    // -- Step 1: spawn with OAuth blob, expect daemon to register it --

    let server = await ensureOpencodeServer(engine, {
      containerId: handle.containerId,
      cwd: SANDBOX_HOME,
      user,
      env: { OPENCODE_AUTH_CONTENT: oauthBlob },
    });

    const openAiSource = async (url: string, password: string) => {
      const credentials = Buffer.from(`opencode:${password}`).toString("base64");
      const r = await fetch(`${url}/config/providers`, {
        headers: { Authorization: `Basic ${credentials}` },
      });
      if (!r.ok) throw new Error(`GET /config/providers returned ${r.status}`);
      const body = (await r.json()) as {
        providers?: { id?: string; source?: string }[];
      };
      const openai = (body.providers ?? []).find((p) => p.id === "openai");
      return openai?.source ?? null;
    };

    expect(
      await openAiSource(server.url, server.password),
      "with OAuth blob in env, daemon should register openai as a custom-sourced provider",
    ).toBe("custom");

    // -- Step 2: respawn with NO OAuth, expect wipe to remove openai --

    invalidateOpencodeServerCache(handle.containerId);
    server = await restartOpencodeServer(engine, {
      containerId: handle.containerId,
      cwd: SANDBOX_HOME,
      user,
      env: {},
    });

    expect(
      await openAiSource(server.url, server.password),
      "after a respawn with no OAuth blob, the wipe must drop the openai 'custom' source — i.e. the auth file rebuilt clean and the leftover PUT registration is gone",
    ).not.toBe("custom");

  }, 60_000);

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
