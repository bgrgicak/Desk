import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression coverage for the cross-module contract that broke in PR #111:
 * `opencode.ts:execRun` must forward `agent.model` to `driver.execRun` so
 * that the per-message `providerID/modelID` reflects the agent's current
 * model. Without this, opencode-serve falls back to whatever the session
 * was originally bound to and UI model changes never reach the daemon.
 *
 * The runtime has heavy side-effects (Docker, session minting, MCP config
 * writes, daemon restarts). We mock the side-effect modules so the test
 * exercises only the argument-plumbing through `opencode.ts:execRun`.
 */

vi.mock("../src/docker.js", () => ({
  sandboxUser: vi.fn(async () => "1000:1000"),
}));

vi.mock("../src/engine.js", () => ({
  detectEngine: vi.fn(async () => ({
    inspect: vi.fn(async () => ({ running: true })),
    port: vi.fn(async () => ({ hostIp: "127.0.0.1", hostPort: 9999 })),
    exec: vi.fn(async () => ({ wait: async () => undefined })),
    execDetached: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => undefined),
    imageId: vi.fn(async () => "img_x"),
  })),
}));

vi.mock("../src/sessions.js", () => ({
  mintToken: vi.fn(async () => ({
    token: "tok_test",
    session: { id: "sess_test" },
  })),
  revokeToken: vi.fn(async () => undefined),
}));

vi.mock("../src/mounts.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/mounts.js")>();
  return {
    ...original,
    projectMounts: vi.fn(async () => undefined),
    teardownMounts: vi.fn(async () => undefined),
  };
});

vi.mock("../src/agentFile.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/agentFile.js")>();
  return {
    ...original,
    writeAgentFile: vi.fn(async () => undefined),
    writeWorkspaceMcpConfig: vi.fn(async () => ({ changed: false })),
  };
});

vi.mock("../src/opencodeServer.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/opencodeServer.js")>();
  return {
    ...original,
    restartOpencodeServer: vi.fn(async () => undefined),
    invalidateOpencodeServerCache: vi.fn(() => null),
    ensureContainerXvfb: vi.fn(async () => undefined),
  };
});

const execRunMock = vi.fn();
vi.mock("../src/driver.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/driver.js")>();
  return {
    ...original,
    createDriver: vi.fn(() => ({
      execRun: execRunMock,
      cancelRun: vi.fn(async () => undefined),
    })),
  };
});

beforeEach(() => {
  execRunMock.mockReset();
  execRunMock.mockResolvedValue({ exitCode: 0, opencodeSessionId: "ses_x" });
});

const { execRun } = await import("../src/opencode.js");

describe("opencode.ts execRun -> driver argument plumbing", () => {
  function baseOpts() {
    return {
      runId: "run_test",
      prompt: "hello",
      home: "/tmp/desk-home",
      workspaceId: "wks_test",
      workspaceSlug: "test-ws",
      agent: {
        agentId: "agt_test",
        agentName: "Desk",
        model: "openai/gpt-5.3-codex",
        userName: "tester",
        userTimezone: "UTC",
        chatId: "cht_test",
        goal: null,
        runMode: "chat" as const,
        workspaceKind: "project" as const,
      },
      onLog: vi.fn(),
    };
  }

  it("forwards `agent.model` as `model` so driver dispatches with the current model", async () => {
    // Was the regression in PR #111: opencode.ts called driver.execRun without
    // `model`, so the driver defaulted to `opencode/big-pickle` and changes to
    // `agent.model` in the UI never reached opencode-serve.
    const handle = { containerId: "ctr_x", workspaceId: "wks_test" } as never;
    await execRun({} as never, handle, baseOpts());
    expect(execRunMock).toHaveBeenCalledOnce();
    expect(execRunMock.mock.calls[0][1]).toMatchObject({
      model: "openai/gpt-5.3-codex",
      agentFileId: "agt_test",
    });
  });

  it("re-forwards the latest `agent.model` on a subsequent turn (model switch propagates)", async () => {
    const handle = { containerId: "ctr_x", workspaceId: "wks_test" } as never;
    await execRun({} as never, handle, {
      ...baseOpts(),
      agent: { ...baseOpts().agent, model: "anthropic/claude-3-5-haiku-latest" },
    });
    await execRun({} as never, handle, {
      ...baseOpts(),
      agent: { ...baseOpts().agent, model: "openai/gpt-5.3-codex" },
    });
    expect(execRunMock).toHaveBeenCalledTimes(2);
    expect(execRunMock.mock.calls[0][1]).toMatchObject({ model: "anthropic/claude-3-5-haiku-latest" });
    expect(execRunMock.mock.calls[1][1]).toMatchObject({ model: "openai/gpt-5.3-codex" });
  });
});
