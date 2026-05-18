import { describe, it, expect } from "vitest";
import {
  buildDaemonEnv,
  buildMessageParts,
  describeDaemonError,
  isContainerGoneError,
  parseModelSpec,
  synthesizeNonTextEvents,
  toSandboxPath,
  type PartEmissionState,
} from "../src/driver.js";
import { _digestEnvForTest } from "../src/opencodeServer.js";
import { SANDBOX_HOME } from "../src/mounts.js";

describe("toSandboxPath", () => {
  it("prepends SANDBOX_HOME to workspace-relative paths", () => {
    expect(toSandboxPath("notes.txt")).toBe(`${SANDBOX_HOME}/notes.txt`);
    expect(toSandboxPath(".chats/cht_1/attachments/x.md")).toBe(
      `${SANDBOX_HOME}/.chats/cht_1/attachments/x.md`,
    );
  });

  it("strips a stray leading slash so absolute-style inputs don't double up", () => {
    expect(toSandboxPath("/Random/file")).toBe(`${SANDBOX_HOME}/Random/file`);
    expect(toSandboxPath("///deep")).toBe(`${SANDBOX_HOME}/deep`);
  });
});

describe("parseModelSpec", () => {
  it("splits provider/model on the first slash", () => {
    expect(parseModelSpec("opencode/big-pickle")).toEqual({
      providerID: "opencode",
      modelID: "big-pickle",
    });
    expect(parseModelSpec("anthropic/claude-3.5-sonnet")).toEqual({
      providerID: "anthropic",
      modelID: "claude-3.5-sonnet",
    });
  });

  it("preserves slashes in the model part after the first one", () => {
    // Some registry-style ids include `/` (e.g. an OpenRouter `org/model`).
    // We split only on the first slash so the provider is the namespace.
    expect(parseModelSpec("openrouter/anthropic/claude-3")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-3",
    });
  });

  it("defaults provider to opencode when there is no slash", () => {
    expect(parseModelSpec("big-pickle")).toEqual({
      providerID: "opencode",
      modelID: "big-pickle",
    });
  });

  it("rewrites the Desk-only `codex/...` relabel back to `openai/...`", () => {
    // Desk's settings UI relabels OpenAI models as `codex/...` when the
    // user authed via the ChatGPT/Codex bridge (no `OPENAI_API_KEY`).
    // The `opencode-serve` daemon only knows the `openai` provider, so
    // dispatching `codex/gpt-5.5` 500s with ProviderModelNotFoundError.
    expect(parseModelSpec("codex/gpt-5.5")).toEqual({
      providerID: "openai",
      modelID: "gpt-5.5",
    });
  });
});

describe("buildDaemonEnv", () => {
  // Regression for the disabled-provider leak: when a user disables a
  // provider in Settings, `resolveProviderKeys` drops it from the map.
  // But the sandbox container was created with that key in its env, and
  // `docker exec` inherits the container's birth env. Unless the daemon
  // is launched with an explicit `-e KEY=` blank, opencode-serve still
  // sees the stale value and happily exposes the provider's models —
  // which is what made an agent on this branch tell the user it had
  // access to OpenAI models after every connection was switched off.

  it("emits blanks for every connection env var the user can manage", () => {
    const env = buildDaemonEnv({ providerKeys: {} });
    // Provider keys
    expect(env.OPENAI_API_KEY).toBe("");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.GEMINI_API_KEY).toBe("");
    // Sandbox connections
    expect(env.GITHUB_TOKEN).toBe("");
    // Managed-connection aliases (e.g. GH_TOKEN mirrors GITHUB_TOKEN)
    expect(env.GH_TOKEN).toBe("");
  });

  it("blanks local-source env vars (e.g. Codex's OPENCODE_AUTH_CONTENT) when the source is off", () => {
    // The companion to the disabled-cloud-provider regression above.
    // Local sources land their auth via `extraEnv`, not `providerKeys`.
    // When the user disables Codex in Settings, `resolveLocalSourceEnv`
    // returns an empty map — but the sandbox container was created
    // back when Codex was enabled, so the birth env still carries
    // `OPENCODE_AUTH_CONTENT`. Without an explicit blank in the daemon
    // env override, opencode-serve inherits the OAuth blob from the
    // container birth and keeps authenticating openai via the Codex
    // path forever after.
    const env = buildDaemonEnv({ providerKeys: {}, extraEnv: {} });
    expect(env.OPENCODE_AUTH_CONTENT).toBe("");
  });

  it("real OPENCODE_AUTH_CONTENT in extraEnv overrides the blank when Codex is on", () => {
    const env = buildDaemonEnv({
      providerKeys: {},
      extraEnv: { OPENCODE_AUTH_CONTENT: "{\"openai\":{\"type\":\"oauth\"}}" },
    });
    expect(env.OPENCODE_AUTH_CONTENT).toContain("oauth");
  });

  it("flips the env digest when Codex is toggled off, forcing a daemon restart", () => {
    // Same shape as the cloud-provider digest test below — toggling a
    // local source on/off must flip the env digest so
    // `ensureOpencodeServer` knows to respawn the daemon with the new
    // env. Without this, opencode-serve keeps its in-memory OAuth-
    // backed openai provider alive across the toggle and the chat
    // silently runs against a "disabled" source.
    const before = _digestEnvForTest(
      buildDaemonEnv({
        providerKeys: {},
        extraEnv: { OPENCODE_AUTH_CONTENT: "{\"openai\":{\"type\":\"oauth\"}}" },
      }),
    );
    const after = _digestEnvForTest(buildDaemonEnv({ providerKeys: {}, extraEnv: {} }));
    expect(before).not.toBe(after);
  });

  it("flips the env digest when an agent file's model changes, forcing a daemon restart", () => {
    // opencode-serve caches each agent's `model:` at startup. So a
    // rewrite of the agent file mid-life — e.g. the no-auth fallback
    // changing `codex/gpt-5.5-fast` to `opencode/big-pickle` — is
    // invisible to the running daemon. Folding the agent-files model
    // digest into the daemon env makes the env-digest compare in
    // `ensureOpencodeServer` notice the rewrite and respawn the
    // daemon so it re-reads the file.
    const before = _digestEnvForTest(
      buildDaemonEnv({ providerKeys: {}, agentFilesDigest: "abc" }),
    );
    const after = _digestEnvForTest(
      buildDaemonEnv({ providerKeys: {}, agentFilesDigest: "xyz" }),
    );
    expect(before).not.toBe(after);
  });

  it("treats an absent vs empty agentFilesDigest as the same env (no spurious restart on workspace bootstrap)", () => {
    // Workspaces created before this digest existed (or with an
    // empty agents dir) must not churn the daemon every turn just
    // because no digest is being passed.
    const absent = _digestEnvForTest(buildDaemonEnv({ providerKeys: {} }));
    const explicitEmpty = _digestEnvForTest(
      buildDaemonEnv({ providerKeys: {}, agentFilesDigest: "" }),
    );
    expect(absent).toBe(explicitEmpty);
  });

  it("real keys override the blanks so enabled providers still flow through", () => {
    const env = buildDaemonEnv({
      providerKeys: { OPENAI_API_KEY: "sk-test", GITHUB_TOKEN: "ghp_test" },
    });
    expect(env.OPENAI_API_KEY).toBe("sk-test");
    expect(env.GITHUB_TOKEN).toBe("ghp_test");
    expect(env.GH_TOKEN).toBe("ghp_test");
    // Other disabled providers still get blanked
    expect(env.ANTHROPIC_API_KEY).toBe("");
  });

  it("changes the opencode-serve env digest when a provider is toggled off", () => {
    // The daemon-restart trigger is a digest mismatch in
    // `ensureOpencodeServer`. Toggling a provider from set → blank must
    // produce a different digest so the cached daemon is rebuilt with
    // the new env that hides the disabled provider from opencode.
    const before = _digestEnvForTest(
      buildDaemonEnv({ providerKeys: { OPENAI_API_KEY: "sk-test" } }),
    );
    const after = _digestEnvForTest(buildDaemonEnv({ providerKeys: {} }));
    expect(before).not.toBe(after);
  });

  it("threads DESK_SANDBOX_TOKEN_PATH and DESK_API_URL through unchanged", () => {
    const env = buildDaemonEnv({ providerKeys: {}, apiUrl: "http://host.docker.internal:8080" });
    expect(env.DESK_SANDBOX_TOKEN_PATH).toBeDefined();
    expect(env.DESK_API_URL).toBe("http://host.docker.internal:8080");
  });
});

describe("synthesizeNonTextEvents", () => {
  // Locks in the contract that broke in PR #111: opencode-serve 1.14.50
  // doesn't broadcast tool/step/reasoning parts over SSE — they only
  // become visible via `GET /session/:id/message` once the turn ends.
  // The runtime fetches that list and synthesizes non-text events so
  // the UI's tool-card / step-marker renderers have something to draw.
  const SES = "ses_test";
  const TURN = {
    parts: [
      { type: "step-start", id: "prt_s1", messageID: "msg_a" },
      {
        type: "reasoning",
        id: "prt_r1",
        text: "thinking...",
        messageID: "msg_a",
      },
      {
        type: "tool",
        id: "prt_t1",
        tool: "bash",
        state: { status: "completed", title: "pwd" },
        messageID: "msg_a",
      },
      { type: "text", id: "prt_x1", text: "the result is X", messageID: "msg_a" },
      { type: "step-finish", id: "prt_e1", reason: "stop", messageID: "msg_a" },
    ],
  };

  it("emits an event for every non-text part with run-format type names (hyphens -> underscores)", () => {
    const lines = [...synthesizeNonTextEvents(TURN, SES)];
    const events = lines.map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual([
      "step_start",
      "reasoning",
      "tool",
      // text part dropped — SSE already streamed it as deltas
      "step_finish",
    ]);
    // Each event carries the daemon-side `part` payload so downstream
    // renderers (ToolCallChip etc.) can read `part.tool` / `part.state`.
    const toolEvent = events.find((e) => e.type === "tool");
    expect(toolEvent.sessionID).toBe(SES);
    expect(toolEvent.part).toEqual({
      type: "tool",
      id: "prt_t1",
      tool: "bash",
      state: { status: "completed", title: "pwd" },
      messageID: "msg_a",
    });
  });

  it("returns nothing when the envelope has no parts (defensive guard)", () => {
    expect([...synthesizeNonTextEvents({}, SES)]).toEqual([]);
    expect([...synthesizeNonTextEvents({ parts: [] }, SES)]).toEqual([]);
    expect([...synthesizeNonTextEvents(null, SES)]).toEqual([]);
  });

  it("skips parts whose `type` field is missing or non-string", () => {
    const malformed = { parts: [{ id: "x" }, { type: 7 }, { type: "step-start" }] };
    const events = [...synthesizeNonTextEvents(malformed, SES)].map((l) =>
      JSON.parse(l),
    );
    expect(events).toEqual([
      expect.objectContaining({ type: "step_start" }),
    ]);
  });

  it("annotates each event with the assistant message's providerID/modelID/agent/mode for debugging", () => {
    // Mirrors the `info` envelope opencode-serve returns from
    // `GET /session/:id/message`. The session can be bound to a
    // different model than the per-message override sent — surfacing
    // the actually-used model on every step makes that diagnosable
    // from the chat log alone.
    const turn = {
      info: {
        id: "msg_a",
        providerID: "anthropic",
        modelID: "claude-3-5-haiku-latest",
        agent: "agt_X",
        mode: "primary",
      },
      parts: [
        { type: "step-start", id: "prt_s", messageID: "msg_a" },
        { type: "step-finish", id: "prt_f", messageID: "msg_a" },
      ],
    };
    const events = [...synthesizeNonTextEvents(turn, SES)].map((l) => JSON.parse(l));
    expect(events).toHaveLength(2);
    for (const ev of events) {
      expect(ev.model).toEqual({
        providerID: "anthropic",
        modelID: "claude-3-5-haiku-latest",
        agent: "agt_X",
        mode: "primary",
      });
    }
  });

  it("collapses static parts (step-start, step-finish) to a single emission across calls with shared state", () => {
    const turn = {
      info: { id: "msg_a", providerID: "anthropic", modelID: "x" },
      parts: [
        { type: "step-start", id: "prt_s1" },
      ],
    };
    const state: PartEmissionState = new Map();
    const first = [...synthesizeNonTextEvents(turn, "ses_x", state)];
    expect(first).toHaveLength(1);
    // Same observation again — static parts collapse.
    const second = [...synthesizeNonTextEvents(turn, "ses_x", state)];
    expect(second).toEqual([]);
    // A NEW static part still yields.
    const newer = {
      info: turn.info,
      parts: [...turn.parts, { type: "step-finish", id: "prt_f1" }],
    };
    const third = [...synthesizeNonTextEvents(newer, "ses_x", state)];
    expect(third).toHaveLength(1);
    expect(JSON.parse(third[0]!).type).toBe("step_finish");
  });

  it("re-emits tool parts on state.status transitions so the UI sees pending → completed updates", () => {
    const state: PartEmissionState = new Map();
    const pending = {
      info: { id: "msg_a", providerID: "opencode", modelID: "big-pickle" },
      parts: [{ type: "tool", id: "prt_t1", tool: "bash", state: { status: "pending" } }],
    };
    const completed = {
      info: pending.info,
      parts: [{ type: "tool", id: "prt_t1", tool: "bash", state: { status: "completed", output: "ok" } }],
    };

    const first = [...synthesizeNonTextEvents(pending, "ses_x", state)].map((l) => JSON.parse(l));
    expect(first).toHaveLength(1);
    expect(first[0].part.state.status).toBe("pending");

    const second = [...synthesizeNonTextEvents(completed, "ses_x", state)].map((l) => JSON.parse(l));
    expect(second).toHaveLength(1);
    expect(second[0].part.state.status).toBe("completed");

    // Same status seen again → no duplicate
    const third = [...synthesizeNonTextEvents(completed, "ses_x", state)];
    expect(third).toEqual([]);
  });

  it("streams reasoning text incrementally — emits only the new suffix as the daemon's text grows", () => {
    const state: PartEmissionState = new Map();
    const obs1 = {
      info: { id: "msg_a", providerID: "opencode", modelID: "big-pickle" },
      parts: [{ type: "reasoning", id: "prt_r1", text: "Let me think." }],
    };
    const obs2 = {
      info: obs1.info,
      parts: [{ type: "reasoning", id: "prt_r1", text: "Let me think. The answer is 42." }],
    };
    // Same observation again — no growth, no emission.
    const obs2Repeat = obs2;

    const first = [...synthesizeNonTextEvents(obs1, "ses_x", state)].map((l) => JSON.parse(l));
    expect(first).toHaveLength(1);
    expect(first[0].part.text).toBe("Let me think.");

    const second = [...synthesizeNonTextEvents(obs2, "ses_x", state)].map((l) => JSON.parse(l));
    expect(second).toHaveLength(1);
    expect(second[0].part.text).toBe(" The answer is 42.");

    const third = [...synthesizeNonTextEvents(obs2Repeat, "ses_x", state)];
    expect(third).toEqual([]);
  });

  it("omits the model annotation when info is missing or malformed (no misleading partial data)", () => {
    const noInfo = { parts: [{ type: "step-start", id: "p" }] };
    const partialInfo = {
      info: { id: "msg_a", providerID: "anthropic" /* no modelID */ },
      parts: [{ type: "step-start", id: "p" }],
    };
    const numericInfo = {
      info: { providerID: 42, modelID: "x" },
      parts: [{ type: "step-start", id: "p" }],
    };
    for (const env of [noInfo, partialInfo, numericInfo]) {
      const events = [...synthesizeNonTextEvents(env, SES)].map((l) => JSON.parse(l));
      expect(events).toHaveLength(1);
      expect(events[0]).not.toHaveProperty("model");
    }
  });
});

describe("isContainerGoneError", () => {
  // Drives the driver's container-re-acquire-and-retry path: any error
  // that matches here causes the next ensureOpencodeServer attempt to
  // fall back on a fresh createOrReuse instead of bailing the run.

  it("matches container-vanished errors from startOpencodeServer", () => {
    expect(isContainerGoneError(
      "opencode-serve: container abc123 not found",
    )).toBe(true);
    expect(isContainerGoneError(
      "opencode-serve: container abc123 is not running",
    )).toBe(true);
  });

  it("matches the ensureOpencodeServer hard-ceiling timeout", () => {
    // When the spawn flow wedges (Docker socket hung, port-bind race),
    // ensureOpencodeServer rejects with this message and evicts the
    // cache. The driver treats it as recoverable so the next attempt
    // gets a fresh container instead of permanently freezing the chat.
    expect(isContainerGoneError(
      "opencode-serve: ensure timed out after 30000ms (container abc123)",
    )).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isContainerGoneError("ECONNREFUSED")).toBe(false);
    expect(isContainerGoneError("docker daemon not responding")).toBe(false);
    expect(isContainerGoneError("")).toBe(false);
  });
});

describe("describeDaemonError", () => {
  // Locks in the contract: opencode-serve resolves `POST /session/:id/
  // message` with an `info.error` payload when the upstream model
  // call fails (zen rate limit, deprecated model, provider 401),
  // never throwing. The driver routes that payload through this
  // helper so the run is recorded as failed *with the actual reason*
  // instead of silently "succeeding" with no text. Without this, the
  // UI's diagnostic banner only sees the Desk-side fallback notice
  // and the user has no clue why the chat is empty.

  it("returns null for missing or empty error envelopes", () => {
    expect(describeDaemonError(undefined)).toBeNull();
    expect(describeDaemonError(null)).toBeNull();
    expect(describeDaemonError("")).toBeNull();
  });

  it("prefers the nested `data.message` over the generic top-level name (the user-facing description lives there)", () => {
    // Real-world shape: APIError with the upstream message buried in
    // `data.message`. opencode-serve's top-level `name` / `message`
    // tend to be class names and stack-frame fragments.
    const result = describeDaemonError({
      name: "APIError",
      data: {
        message: "Model big-pickle not supported for format anthropic",
        statusCode: 401,
        responseBody: "{...}",
      },
    });
    expect(result).toBe(
      "APIError: Model big-pickle not supported for format anthropic (HTTP 401)",
    );
  });

  it("falls back to top-level `message` when `data` is missing", () => {
    const result = describeDaemonError({ name: "ProviderModelNotFoundError", message: "no such model" });
    expect(result).toBe("ProviderModelNotFoundError: no such model");
  });

  it("uses the bare name when only `name` is set", () => {
    expect(describeDaemonError({ name: "InternalError" })).toBe("InternalError");
  });

  it("threads bare strings through unchanged for ad-hoc errors", () => {
    expect(describeDaemonError("upstream timeout")).toBe("upstream timeout");
  });

  it("serializes opaque error objects so the chat log still gets *something*", () => {
    // Defensive: even if opencode-serve changes its error shape, the
    // user shouldn't see a "[object Object]" placeholder — the JSON
    // body is at least diagnosable.
    const result = describeDaemonError({ foo: "bar", baz: 42 });
    expect(result).toContain("foo");
    expect(result).toContain("bar");
  });
});

describe("buildMessageParts", () => {
  it("emits a single text part for a prompt with no attachments", () => {
    const parts = buildMessageParts({ prompt: "Hello" });
    expect(parts).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("appends one text part per attachment with the sandbox-absolute path", () => {
    const parts = buildMessageParts({
      prompt: "Read the attached file.",
      attachments: ["notes.txt", "subdir/page.md"],
    });
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: "text", text: "Read the attached file." });
    const first = parts[1] as { type: string; text: string };
    const second = parts[2] as { type: string; text: string };
    expect(first.type).toBe("text");
    expect(first.text).toContain(`${SANDBOX_HOME}/notes.txt`);
    expect(second.text).toContain(`${SANDBOX_HOME}/subdir/page.md`);
  });
});
