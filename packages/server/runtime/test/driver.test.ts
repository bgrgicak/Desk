import { describe, it, expect } from "vitest";
import {
  buildDaemonEnv,
  buildPiEnv,
  describeModelFailure,
  isContainerGoneError,
  isModelFailure,
  parseModelSpec,
  buildPiPrompt,
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

  it("includes DESK_API_URL only when supplied", () => {
    const without = buildPiEnv({});
    expect(without.DESK_API_URL).toBeUndefined();
    const withUrl = buildPiEnv({ apiUrl: "http://host.docker.internal:35138" });
    expect(withUrl.DESK_API_URL).toBe("http://host.docker.internal:35138");
  });

  it("always emits DESK_SANDBOX_TOKEN_PATH so the in-sandbox CLI knows where to read", () => {
    const env = buildPiEnv({});
    expect(env.DESK_SANDBOX_TOKEN_PATH).toBe("/tmp/desk-sandbox-token");
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

  it("relabels codex/* → openai (Desk-internal UI relabel)", () => {
    expect(parseModelSpec("codex/gpt-5.5")).toEqual({
      providerID: "openai",
      modelID: "gpt-5.5",
    });
  });

  it("returns no providerID for bare model ids", () => {
    expect(parseModelSpec("claude-haiku-4-5")).toEqual({
      modelID: "claude-haiku-4-5",
    });
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

describe("isModelFailure", () => {
  it("returns false on success (exit 0)", () => {
    expect(isModelFailure(0, "")).toBe(false);
    expect(isModelFailure(0, "rate limit hit but exit was 0")).toBe(false);
  });

  it("returns false on cancellation exits", () => {
    // 130 = SIGTERM (user cancel), 137 = SIGKILL — falling back to a
    // different model on cancel would surprise the user with extra work
    // they explicitly stopped.
    expect(isModelFailure(130, "rate limited")).toBe(false);
    expect(isModelFailure(137, "anything")).toBe(false);
  });

  it("matches pi's auth-missing stderr (the chaos-test smoking gun)", () => {
    expect(isModelFailure(1, "No API key found for openai-codex.")).toBe(true);
    expect(isModelFailure(1, "No live auth for anthropic/claude-haiku-4-5")).toBe(true);
  });

  it("matches rate-limit / quota / 429 shapes from upstream providers", () => {
    expect(isModelFailure(1, "Anthropic returned 429: rate_limited")).toBe(true);
    expect(isModelFailure(1, "quota exceeded for this billing period")).toBe(true);
    expect(isModelFailure(1, "too many requests, please retry in 30s")).toBe(true);
  });

  it("matches provider 5xx outages", () => {
    expect(isModelFailure(1, "OpenAI 503 Service Unavailable")).toBe(true);
    expect(isModelFailure(1, "overloaded")).toBe(true);
  });

  it("matches model-not-found shapes (provider deprecated the id, or typo)", () => {
    expect(isModelFailure(1, "ProviderModelNotFoundError: no such model gpt-5.7")).toBe(true);
    expect(isModelFailure(1, "model not found: claude-omega")).toBe(true);
    expect(isModelFailure(1, "invalid model: foo")).toBe(true);
  });

  it("returns false for container/sandbox shapes (those have their own retry)", () => {
    // Container-gone is handled by the upstream retry loop, not by
    // switching model — falling back here would burn a fallback slot
    // for a recoverable infra error.
    expect(isModelFailure(1, "No such container: abc123")).toBe(false);
    expect(isModelFailure(1, "spawn EAGAIN")).toBe(false);
  });
});

describe("describeModelFailure", () => {
  it("picks the most specific reason from common stderr patterns", () => {
    expect(describeModelFailure(1, "No API key found for openai")).toBe("no API key");
    expect(describeModelFailure(1, "Anthropic returned 429")).toBe("rate limited");
    expect(describeModelFailure(1, "quota exceeded")).toBe("quota exceeded");
    expect(describeModelFailure(1, "401 Unauthorized")).toBe("unauthorized");
    expect(describeModelFailure(1, "503 Service Unavailable")).toBe("provider 5xx");
    expect(describeModelFailure(1, "ProviderModelNotFoundError")).toBe("model not found");
  });

  it("falls back to the exit code when no pattern matches", () => {
    expect(describeModelFailure(42, "something weird")).toBe("pi exited 42");
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
    expect(isContainerGoneError("opencode-serve: ensure timed out after 30000ms (container abc)")).toBe(true);
  });

  it("returns false for ordinary failures", () => {
    expect(isContainerGoneError("ECONNREFUSED")).toBe(false);
    expect(isContainerGoneError("model not found")).toBe(false);
  });
});
