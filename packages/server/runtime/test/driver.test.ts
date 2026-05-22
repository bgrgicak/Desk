import { describe, it, expect } from "vitest";
import {
  buildDaemonEnv,
  buildPiEnv,
  isContainerGoneError,
  parseModelSpec,
  piModelReference,
  buildPiPrompt,
  modelAttemptSpecs,
  sandboxTokenPath,
  toSandboxPath,
} from "../src/driver.js";
import { SANDBOX_HOME } from "../src/mounts.js";

describe("buildPiEnv / buildDaemonEnv (alias)", () => {
  it("forwards provider keys verbatim", () => {
    const env = buildPiEnv({ providerKeys: { ANTHROPIC_API_KEY: "secret-123" } });
    expect(env.ANTHROPIC_API_KEY).toBe("secret-123");
  });

  it("emits known connection vars as empty strings when not provided so birth-env values can't leak", () => {
    // Disabled provider env names land as empty values, not omitted. A
    // `docker exec -e KEY=` overrides whatever value was baked in at
    // container create time, so toggling a provider off in Settings
    // actually hides it from pi rather than leaking through the warm
    // container environment.
    const env = buildPiEnv({ providerKeys: {} });
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.OPENAI_API_KEY).toBe("");
  });

  it("expands managed-connection aliases (e.g. GITHUB_TOKEN → GH_TOKEN)", () => {
    const env = buildPiEnv({
      providerKeys: { GITHUB_TOKEN: "ghp_abc" },
    });
    expect(env.GITHUB_TOKEN).toBe("ghp_abc");
    expect(env.GH_TOKEN).toBe("ghp_abc");
  });

  it("includes ROOMY_API_URL only when supplied", () => {
    const without = buildPiEnv({});
    expect(without.ROOMY_API_URL).toBeUndefined();
    const withUrl = buildPiEnv({ apiUrl: "http://host.docker.internal:35138" });
    expect(withUrl.ROOMY_API_URL).toBe("http://host.docker.internal:35138");
  });

  it("emits a per-run ROOMY_SANDBOX_TOKEN_PATH so concurrent runs in the same workspace can't stomp each other's tokens", () => {
    const env = buildPiEnv({ runId: "run_abc" });
    expect(env.ROOMY_SANDBOX_TOKEN_PATH).toBe("/tmp/roomy-sandbox-token-run_abc");
    // Distinct run ids must yield distinct paths — that's the whole
    // point. If they collided, two runs would still race on /tmp.
    const other = buildPiEnv({ runId: "run_xyz" });
    expect(other.ROOMY_SANDBOX_TOKEN_PATH).toBe("/tmp/roomy-sandbox-token-run_xyz");
  });

  it("omits ROOMY_SANDBOX_TOKEN_PATH when runId is absent (non-run callers like connection-refresh env-digest)", () => {
    const env = buildPiEnv({});
    expect(env).not.toHaveProperty("ROOMY_SANDBOX_TOKEN_PATH");
  });

  it("exposes the buildDaemonEnv alias for legacy callers", () => {
    expect(buildDaemonEnv).toBe(buildPiEnv);
  });
});

describe("parseModelSpec", () => {
  it("splits `<provider>/<model>` into providerID + modelID", () => {
    expect(parseModelSpec("anthropic/claude-haiku-4-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    });
  });

  it("relabels codex/* → openai-codex (Roomy's UI prefix → pi's OAuth provider id)", () => {
    expect(parseModelSpec("codex/gpt-5.5")).toEqual({
      providerID: "openai-codex",
      modelID: "gpt-5.5",
    });
  });

  it("returns no providerID for bare model ids", () => {
    expect(parseModelSpec("claude-haiku-4-5")).toEqual({
      modelID: "claude-haiku-4-5",
    });
  });
});

describe("modelAttemptSpecs", () => {
  it("keeps the primary model first and de-duplicates fallback models", () => {
    expect(modelAttemptSpecs("anthropic/fail", [
      "anthropic/fail",
      "openai-codex/gpt-5.5",
      "openai/gpt-5.4",
      "openai-codex/gpt-5.5",
      "",
    ])).toEqual([
      "anthropic/fail",
      "openai-codex/gpt-5.5",
      "openai/gpt-5.4",
    ]);
  });

  it("returns fallbacks when the primary model is omitted", () => {
    expect(modelAttemptSpecs(undefined, ["openai/gpt-5.4"])).toEqual(["openai/gpt-5.4"]);
  });
});

describe("piModelReference", () => {
  it("normalizes Roomy's codex provider prefix for pi model scopes", () => {
    expect(piModelReference("codex/gpt-5.5")).toBe("openai-codex/gpt-5.5");
    expect(piModelReference("openai/gpt-5.4")).toBe("openai/gpt-5.4");
    expect(piModelReference("gpt-5.4")).toBe("gpt-5.4");
  });
});

describe("buildPiPrompt", () => {
  it("returns the prompt verbatim when there are no attachments", () => {
    expect(buildPiPrompt({ prompt: "Hello" })).toBe("Hello");
  });

  it("folds each attachment in as a `read this file` reference using the sandbox path", () => {
    const out = buildPiPrompt({
      prompt: "Summarize",
      attachments: ["notes/intro.md", ".chats/cht_a/attachments/x.png"],
    });
    expect(out).toContain("Summarize");
    expect(out).toContain(`Attachment: ${SANDBOX_HOME}/notes/intro.md`);
    expect(out).toContain(`Attachment: ${SANDBOX_HOME}/.chats/cht_a/attachments/x.png`);
    expect(out).toContain("read this file from the workspace");
  });
});

describe("toSandboxPath", () => {
  it("prepends SANDBOX_HOME and strips leading slashes", () => {
    expect(toSandboxPath("foo/bar.md")).toBe(`${SANDBOX_HOME}/foo/bar.md`);
    expect(toSandboxPath("/foo/bar.md")).toBe(`${SANDBOX_HOME}/foo/bar.md`);
  });
});


describe("sandboxTokenPath", () => {
  it("returns a runId-scoped /tmp path", () => {
    expect(sandboxTokenPath("run_abc")).toBe("/tmp/roomy-sandbox-token-run_abc");
  });
});

describe("isContainerGoneError", () => {
  it("matches the engine-emitted shapes for a missing container", () => {
    expect(isContainerGoneError("Error response from daemon: No such container: abc")).toBe(true);
    expect(isContainerGoneError("no such object: abc123")).toBe(true);
    expect(isContainerGoneError("container abc is not running")).toBe(true);
    expect(isContainerGoneError("container abc not found")).toBe(true);
  });

  it("matches the ensure-timeout marker so the driver retries on a wedged docker socket", () => {
    expect(isContainerGoneError("pi: ensure timed out after 30000ms (container abc)")).toBe(true);
  });

  it("returns false for ordinary failures", () => {
    expect(isContainerGoneError("ECONNREFUSED")).toBe(false);
    expect(isContainerGoneError("model not found")).toBe(false);
  });
});
