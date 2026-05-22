/**
 * Integration test: prompt-routing behavior for structured UI fragments.
 *
 * Each test sends a user prompt to a real pi-backed sandbox
 * (free `anthropic/claude-haiku-4-5` model) and asserts that the agent reached
 * for the right surface:
 *   - the built-in `chat-forms.app` for structured questions, or
 *   - the built-in `chat-cards.app` for browseable result lists
 *     (NOTE: this app does not exist yet on this branch — the relevant
 *     tests will fail until it lands; that's by design, the failure
 *     drives what we ship next).
 *
 * We detect the agent's intent by scanning the run's event stream for
 * `roomy-agent chat attach-artifact /opt/roomy-apps/<app>.app/dist/fragments/<name>`
 * bash invocations. The actual POST will fail in this harness because we
 * pass a synthetic chatId (no real roomy-server backing it) — that's fine:
 * we only care about whether the agent picked the right path on its first
 * attempt, not whether the attach round-trip succeeded. The agent's later
 * apology / retry / fallback after the fake POST 404s is ignored.
 *
 * Preconditions:
 *   - Docker available + `roomy/sandbox:v1` image present (otherwise skipped).
 *   - chat-forms.app dist built. Run once before this file:
 *       npm --workspace @roomy-ai/chat-forms-app run build
 *     (Same precondition as `chat-forms-fragment-sizing.spec.ts`.)
 *
 * These tests are slow — each one is one real free-model turn (~10–30s).
 * Budget ~5 minutes for the whole file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureLayout, ensureWorkspaceLayout } from "@roomy-ai/storage";
import { createOrReuse, sandboxImage } from "../../src/docker.js";
import { createDriver, type LogEvent } from "../../src/driver.js";
import { detectEngine, type Engine } from "../../src/engine.js";
import { writeBuiltinApps } from "../../src/builtinApps.js";
import { loadCodexEnv } from "../../src/localSources/codex.js";
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

const FREE_MODEL = "anthropic/claude-haiku-4-5";
// pi only knows the `openai` provider; `codex/<name>` is a
// Roomy UI relabel. Use the canonical `openai/...` form so the daemon
// doesn't have to translate (and so we don't trip the `codex/X` →
// `anthropic/claude-haiku-4-5` fallback when something looks off about auth).
const CODEX_MODEL = "openai/gpt-5.5";

// Pick a stronger model when the host has a Codex (ChatGPT) login on disk.
// Big-pickle was observed to ignore the chat-cards routing rule no matter
// how the prompt was reshaped (see notes/agent-prompt-routing.md); a
// frontier model is the second variable to isolate. When no Codex auth
// is present we fall back to big-pickle so the suite still runs on
// CI / first-time machines — those runs are expected to fail on the
// positive cards/forms assertions and that's documented in the file
// header.
const CODEX_AUTH_ENV = loadCodexEnv();
const ROUTING_MODEL =
  process.env.ROOMY_ROUTING_MODEL ??
  (CODEX_AUTH_ENV ? CODEX_MODEL : FREE_MODEL);

let home: string;
const testWorkspaceIdPrefix = "wks_routing";
const testWorkspaceSlugPrefix = "routing";
const FAKE_CHAT_ID = "cht_routing_test_synthetic";
// Track every per-test workspace so afterAll can clean up the leftover
// containers and we don't pollute the docker daemon between runs.
const createdWorkspaceIds = new Set<string>();

beforeAll(async () => {
  if (SKIP) return;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-routing-int-"));
  await ensureLayout(home);
  // Mirror packages/apps/ into ~/.apps/ so the sandbox mount plan
  // can bind it read-only at /opt/roomy-apps/. Without this the agent's
  // attach-artifact call resolves to a non-existent path before we even
  // get to assert anything about the prompt-routing decision.
  await writeBuiltinApps(home);
  process.env.ROOMY_HOME = home;
  // eslint-disable-next-line no-console
  console.log(
    `[routing-test] model=${ROUTING_MODEL} codex_auth=${CODEX_AUTH_ENV ? "yes" : "no"}`,
  );
});

afterAll(async () => {
  if (SKIP) return;
  if (engineForSetup) {
    for (const wid of createdWorkspaceIds) {
      await engineForSetup
        .remove(`roomy-sandbox-${wid}`, true)
        .catch(() => {});
    }
  }
  await rmTempTree(home);
});

interface AttachCommand {
  app: string;
  fragment: string;
  /** Raw `--param key=value` tokens in order, unparsed. */
  paramTokens: string[];
  /** The whole bash command line as captured. */
  raw: string;
}

/**
 * Walks the driver's event stream looking for bash-tool invocations whose
 * command line includes `roomy-agent chat attach-artifact
 * /opt/roomy-apps/<app>.app/dist/fragments/<name> …`. Returns one entry per
 * match in arrival order.
 *
 * The driver synthesizes tool/step events from the post-turn message API
 * (see execRun.test.ts for the contract). We don't depend on a
 * specific JSON shape — we just scan event payloads as strings and pull
 * the attach paths out with a regex. If the event-shape changes, the test
 * still works as long as the bash command text is preserved somewhere in
 * the payload.
 */
function collectAttachCommands(events: LogEvent[]): AttachCommand[] {
  const out: AttachCommand[] = [];
  const attachRe =
    /roomy-agent\s+chat\s+attach-artifact\s+(\/opt\/roomy-apps\/([a-z][a-z0-9-]*)\.app\/dist\/fragments\/([a-z][a-z0-9-]*))(?:\s+([^\n\r]*))?/;
  for (const evt of events) {
    if (evt.kind !== "event") continue;
    const m = attachRe.exec(evt.payload);
    if (!m) continue;
    const tail = m[4] ?? "";
    // Split on `--param ` so we recover individual key=value pairs even
    // when values contain spaces or shell-quoted JSON.
    const paramTokens = tail
      .split(/--param\s+/)
      .slice(1)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    out.push({
      app: m[2],
      fragment: m[3],
      paramTokens,
      raw: m[0],
    });
  }
  return out;
}

interface RunResult {
  exitCode: number;
  events: LogEvent[];
  attaches: AttachCommand[];
  /** Concatenated text deltas — the agent's visible reply. */
  text: string;
}

async function runPrompt(
  runId: string,
  prompt: string,
): Promise<RunResult> {
  // Per-test workspace + container. Sharing across tests turned out to
  // be fragile: when one turn fails mid-way, the next test's
  // createOrReuse hits "container is marked for removal" or
  // "container vanished mid-daemon-start" and the recovery loop bombs.
  // Isolation costs ~10s of cold start per test but eliminates the
  // class of failures entirely.
  const workspaceId = `${testWorkspaceIdPrefix}_${runId}`;
  const workspaceSlug = `${testWorkspaceSlugPrefix}-${runId.replace(/_/g, "-")}`;
  createdWorkspaceIds.add(workspaceId);
  await ensureWorkspaceLayout(home, workspaceSlug);
  // Forward the host's Codex (ChatGPT) auth into the sandbox when we
  // have it. Without this, `codex/*` models silently rewrite to
  // big-pickle inside the runtime fallback path, and we lose the
  // stronger-model signal we're trying to measure.
  const extraEnv = CODEX_AUTH_ENV ?? undefined;
  const handle = await createOrReuse(
    workspaceId,
    workspaceSlug,
    home,
    {},
    undefined,
    extraEnv,
  );
  void handle;
  const driver = createDriver();
  const events: LogEvent[] = [];
  // Deliberately do NOT pass apiUrl. The in-sandbox `roomy-agent` CLI
  // will error fast with "ROOMY_API_URL is not set", which propagates as
  // a non-zero bash exit code into the agent's tool output. The free
  // model has been observed to settle the turn quickly after one such
  // failed attach attempt (it doesn't loop on retries). What we care
  // about lives in the synthesized tool events: the bash command string
  // contains the full `roomy-agent chat attach-artifact …` line the
  // agent assembled, which is the routing signal regardless of whether
  // the POST succeeded.
  const result = await driver.execRun(workspaceId, {
    runId,
    prompt,
    workspaceSlug,
    chatId: FAKE_CHAT_ID,
    model: ROUTING_MODEL,
    providerKeys: {},
    extraEnv,
    onLog: (evt) => {
      events.push(evt);
    },
  });
  const attaches = collectAttachCommands(events);
  let text = "";
  for (const e of events) {
    if (e.kind !== "event") continue;
    try {
      const parsed = JSON.parse(e.payload) as {
        type?: string;
        part?: { text?: string };
      };
      if (parsed.type === "text" && typeof parsed.part?.text === "string") {
        text += parsed.part.text;
      }
    } catch {
      // not JSON — ignore.
    }
  }
  return { exitCode: result.exitCode, events, attaches, text };
}

function describeAttaches(attaches: AttachCommand[]): string {
  if (attaches.length === 0) return "no attach-artifact calls in the stream";
  return attaches
    .map(
      (a, i) =>
        `  [${i}] app=${a.app} fragment=${a.fragment} params=${JSON.stringify(
          a.paramTokens,
        )}`,
    )
    .join("\n");
}

/**
 * Summary of an event stream when a test fails — used to figure out
 * what the agent actually did during the 5-min budget. Reports event
 * type counts and the first few bash commands the agent issued (the
 * full attach line we care about would also live here).
 */
function describeEvents(events: LogEvent[]): string {
  const types = new Map<string, number>();
  const bashCommands: string[] = [];
  for (const e of events) {
    if (e.kind !== "event") {
      types.set(e.kind, (types.get(e.kind) ?? 0) + 1);
      continue;
    }
    let parsed: { type?: string; part?: { type?: string; tool?: string; state?: { input?: { command?: string } } } } | null = null;
    try {
      parsed = JSON.parse(e.payload);
    } catch {
      types.set("(unparseable)", (types.get("(unparseable)") ?? 0) + 1);
      continue;
    }
    const t = parsed?.type ?? "(no-type)";
    types.set(t, (types.get(t) ?? 0) + 1);
    // Tool-use events often carry the bash command in part.state.input.command.
    const cmd = parsed?.part?.state?.input?.command;
    if (typeof cmd === "string") bashCommands.push(cmd.slice(0, 200));
  }
  const typeSummary = [...types.entries()]
    .map(([t, n]) => `${t}=${n}`)
    .join(" ");
  const cmdSummary = bashCommands.length
    ? `bash commands (${bashCommands.length}):\n${bashCommands
        .slice(0, 5)
        .map((c, i) => `  [${i}] ${c}`)
        .join("\n")}${bashCommands.length > 5 ? `\n  …(+${bashCommands.length - 5} more)` : ""}`
    : "no bash commands captured";
  return `event types: ${typeSummary}\n${cmdSummary}`;
}

describeIf("agent prompt routing — chat-forms (structured questions)", () => {
  it("yes/no question → attaches chat-forms.app yes-no fragment", async () => {
    // Smallest possible structured-question signal. The prompt is
    // shaped as "user delegates a task that requires a binary decision
    // FROM the user" — so the agent must ask the user, not opine.
    const r = await runPrompt(
      "route_yesno",
      "Set up a nightly cron that takes a Postgres backup at 2am. Before you create it, ask me whether you should include the staging database in the same backup or only production.",
    );
    const formAttaches = r.attaches.filter((a) => a.app === "chat-forms");
    expect(
      formAttaches.length,
      `expected ≥1 chat-forms attach, got:\n${describeAttaches(r.attaches)}\nexitCode=${r.exitCode} events=${r.events.length}\n${describeEvents(r.events)}\n--- agent reply ---\n${r.text}`,
    ).toBeGreaterThan(0);
    // Allow either yes-no (canonical) or multi-step (if the agent
    // generalized to the wizard). single-choice with two options would
    // also be acceptable in principle — list whatever the agent picks
    // and the test passes only on the binary-shaped ones.
    const fragments = new Set(formAttaches.map((a) => a.fragment));
    expect(
      fragments.has("yes-no") ||
        fragments.has("multi-step") ||
        fragments.has("single-choice"),
      `expected yes-no | multi-step | single-choice, got: ${[...fragments].join(",")}`,
    ).toBe(true);
  }, 300_000);

  it("pick-one question → attaches single-choice (or multi-step)", async () => {
    // Three named options + an explicit instruction to ask the user. A
    // robust routing rule should attach single-choice here.
    const r = await runPrompt(
      "route_singlechoice",
      "I want to scaffold a new project. Ask me whether it should be a web app, a CLI tool, or a library — once I pick one you'll continue from there.",
    );
    const formAttaches = r.attaches.filter((a) => a.app === "chat-forms");
    expect(
      formAttaches.length,
      `expected ≥1 chat-forms attach, got:\n${describeAttaches(r.attaches)}\nexitCode=${r.exitCode} events=${r.events.length}\n${describeEvents(r.events)}\n--- agent reply ---\n${r.text}`,
    ).toBeGreaterThan(0);
    const fragments = new Set(formAttaches.map((a) => a.fragment));
    expect(
      fragments.has("single-choice") || fragments.has("multi-step"),
      `expected single-choice | multi-step, got: ${[...fragments].join(",")}`,
    ).toBe(true);
  }, 300_000);

  it("4-question intake → attaches multi-step wizard", async () => {
    // The rule explicitly says: prefer multi-step over stacking three or
    // more single-question fragments. This is the canonical case.
    const r = await runPrompt(
      "route_multistep",
      [
        "Help me create a new habit tracker. Before you scaffold it, ask me for these four pieces of info — all of them, in one go, not one at a time:",
        "1) habit name (short text),",
        "2) how often (daily / weekly / monthly),",
        "3) reminder time (HH:MM),",
        "4) whether to track streaks (yes/no).",
        "I'll fill them in and you'll continue from there.",
      ].join(" "),
    );
    const multiStep = r.attaches.filter(
      (a) => a.app === "chat-forms" && a.fragment === "multi-step",
    );
    expect(
      multiStep.length,
      `expected multi-step attach for a 4-question intake; got:\n${describeAttaches(r.attaches)}\nexitCode=${r.exitCode} events=${r.events.length}\n${describeEvents(r.events)}\n--- agent reply ---\n${r.text}`,
    ).toBeGreaterThan(0);
    // Genericity probe: the steps payload should contain all four field
    // hints in some recognizable form, not just the first one.
    const stepsTok = multiStep[0]?.paramTokens.find((t) =>
      t.startsWith("steps="),
    );
    expect(stepsTok, "multi-step attach must pass --param steps=...").toBeTruthy();
    for (const needle of ["habit", "often", "reminder", "streak"]) {
      expect(
        (stepsTok ?? "").toLowerCase(),
        `multi-step steps payload should mention "${needle}". Got: ${stepsTok}`,
      ).toContain(needle);
    }
    // The multi-step prompt has historically run long under the free
    // model — the agent assembles a JSON payload with several question
    // strings, and the per-token throughput on big-pickle drops once the
    // output is structured. 10 min keeps headroom without masking a
    // genuine stall.
  }, 600_000);

  it("ambiguous reference → agent asks inline, no fragment attached", async () => {
    // User makes an ambiguous reference with no prior context. The rule
    // allows the agent to disambiguate inline ("did you mean X or Y?")
    // rather than attaching a form for what is just confirming the
    // agent's own interpretation. If the agent attaches a form here, the
    // inline-exception is not working.
    const r = await runPrompt(
      "route_inline_clarify",
      "Can you finish what we were working on yesterday and send me the result?",
    );
    const formAttaches = r.attaches.filter((a) => a.app === "chat-forms");
    expect(
      formAttaches.length,
      `expected NO chat-forms attach for a one-shot clarification; got:\n${describeAttaches(r.attaches)}\nexitCode=${r.exitCode} events=${r.events.length}\n${describeEvents(r.events)}\n--- agent reply ---\n${r.text}`,
    ).toBe(0);
  }, 300_000);

  it("explicit 'plain text' override → no fragment attached", async () => {
    // The rule says: if the user explicitly asks for plain chat, honor it.
    const r = await runPrompt(
      "route_plaintext_override",
      "Just answer in plain text — name three popular Rust HTTP libraries and one sentence about each.",
    );
    const anyAttach = r.attaches.filter(
      (a) => a.app === "chat-forms" || a.app === "chat-cards",
    );
    expect(
      anyAttach.length,
      `expected NO fragment attach when user requests plain text; got:\n${describeAttaches(r.attaches)}\nexitCode=${r.exitCode} events=${r.events.length}\n${describeEvents(r.events)}\n--- agent reply ---\n${r.text}`,
    ).toBe(0);
  }, 300_000);
});

describeIf("agent prompt routing — chat-cards (browseable results)", () => {
  // These tests currently fail by design: chat-cards.app does not exist
  // on this branch, and roomy-skills.md does not yet teach the agent
  // about it. The failure shape (what the agent did instead — inline
  // markdown? a chat-forms fallback? attached something else?) is the
  // signal we use to write the cards routing rule + the chat-cards.app
  // scaffold. Mark with `.fails()` once the surface lands.

  it("product list query → attaches chat-cards.app grid (or list)", async () => {
    const r = await runPrompt(
      "route_cards_products",
      "Find me 5 noise-cancelling headphones under €250. Include title, a one-line verdict, image, and a link to each.",
    );
    const cardAttaches = r.attaches.filter((a) => a.app === "chat-cards");
    expect(
      cardAttaches.length,
      `expected chat-cards attach for a 5-result product list; got:\n${describeAttaches(r.attaches)}\nexitCode=${r.exitCode} events=${r.events.length}\n${describeEvents(r.events)}\n--- agent reply ---\n${r.text.slice(0, 800)}`,
    ).toBeGreaterThan(0);
    const fragments = new Set(cardAttaches.map((a) => a.fragment));
    expect(
      fragments.has("grid") || fragments.has("list"),
      `expected grid | list, got: ${[...fragments].join(",")}`,
    ).toBe(true);
  }, 300_000);

  it("article search → attaches chat-cards.app list", async () => {
    const r = await runPrompt(
      "route_cards_articles",
      "Find me 3 recent articles about Rust async runtimes. For each include title, source, date, and link.",
    );
    const cardAttaches = r.attaches.filter((a) => a.app === "chat-cards");
    expect(
      cardAttaches.length,
      `expected chat-cards attach for an article search; got:\n${describeAttaches(r.attaches)}\nexitCode=${r.exitCode} events=${r.events.length}\n${describeEvents(r.events)}\n--- agent reply ---\n${r.text.slice(0, 800)}`,
    ).toBeGreaterThan(0);
    // List is the natural fit for text-heavy article results, but grid
    // is also acceptable — the rule's job is to pick chat-cards, not
    // specifically grid-vs-list.
    const fragments = new Set(cardAttaches.map((a) => a.fragment));
    expect(
      fragments.has("list") || fragments.has("grid"),
      `expected list | grid, got: ${[...fragments].join(",")}`,
    ).toBe(true);
  }, 300_000);

  it("entity lookup → attaches a single chat-cards card (genericity probe)", async () => {
    // Borderline case: "what is MCP?" could reasonably be answered with
    // a single card (definition + official link) or a short inline
    // paragraph. We assert chat-cards, but a clean inline reply is also
    // a valid outcome — adjust this test once you see how the agent
    // handles it. If the rule turns out to be "use cards only for 2+
    // items", flip this test to assert NO cards attach.
    const r = await runPrompt(
      "route_cards_entity",
      "What is Anthropic's Model Context Protocol? Give me the gist and an official link.",
    );
    const cardAttaches = r.attaches.filter((a) => a.app === "chat-cards");
    expect(
      cardAttaches.length,
      `expected at least one chat-cards attach for an entity lookup; got:\n${describeAttaches(r.attaches)}\nexitCode=${r.exitCode} events=${r.events.length}\n${describeEvents(r.events)}\n--- agent reply ---\n${r.text.slice(0, 800)}`,
    ).toBeGreaterThan(0);
  }, 300_000);
});
