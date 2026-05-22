import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "../src/engine.js";
import type { PiHandle, PiRunOptions } from "../src/piClient.js";

const state = vi.hoisted(() => ({
  createCalls: 0,
  containerSeq: 0,
  exitCodes: [] as number[],
  aborted: [] as boolean[],
  resultModels: [] as Array<string | undefined>,
  runCalls: [] as Array<{
    containerId: string;
    provider?: string;
    model?: string;
    models?: string[];
  }>,
}));

vi.mock("../src/engine.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/engine.js")>();
  return {
    ...original,
    detectEngine: vi.fn(async () => ({ name: "docker" }) as Engine),
  };
});

vi.mock("../src/docker.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/docker.js")>();
  return {
    ...original,
    connectionEnvNames: vi.fn(() => []),
    sandboxUser: vi.fn(async () => "1000:1000"),
    createOrReuse: vi.fn(async (workspaceId: string) => {
      state.createCalls++;
      state.containerSeq++;
      return { workspaceId, containerId: `ctr_${state.containerSeq}` };
    }),
  };
});

vi.mock("../src/piClient.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/piClient.js")>();
  return {
    ...original,
    runPi: vi.fn((_engine: Engine, opts: PiRunOptions): PiHandle => {
      state.runCalls.push({
        containerId: opts.containerId,
        provider: opts.provider,
        model: opts.model,
        models: opts.models,
      });
      const exitCode = state.exitCodes.shift() ?? 0;
      const aborted = state.aborted.shift() ?? false;
      const model = state.resultModels.shift();
      if (exitCode !== 0) void opts.onStderr(`simulated exit ${exitCode}`);
      return {
        containerId: opts.containerId,
        done: Promise.resolve({ exitCode, aborted, ...(model ? { model } : {}) }),
        cancel: async () => {},
      };
    }),
  };
});

const originalSandboxDriver = process.env.DESK_SANDBOX_DRIVER;

beforeEach(() => {
  state.createCalls = 0;
  state.containerSeq = 0;
  state.exitCodes = [];
  state.aborted = [];
  state.resultModels = [];
  state.runCalls = [];
  delete process.env.DESK_SANDBOX_DRIVER;
});

afterEach(() => {
  if (originalSandboxDriver === undefined) {
    delete process.env.DESK_SANDBOX_DRIVER;
  } else {
    process.env.DESK_SANDBOX_DRIVER = originalSandboxDriver;
  }
});

describe("driver PI model scope", () => {
  it("passes the ordered active models to one PI invocation and records PI's winning model", async () => {
    state.exitCodes = [0];
    state.resultModels = ["openai-codex/gpt-5.5"];
    const { createDriver } = await import("../src/driver.js");

    const result = await createDriver().execRun("wks_fallback", {
      runId: "run_fallback",
      workspaceSlug: "fallback-workspace",
      prompt: "hi",
      model: "anthropic/claude-sonnet-4-6",
      modelFallbacks: ["codex/gpt-5.5", "openai/gpt-5.4"],
      onLog: () => {},
    });

    expect(result).toMatchObject({
      exitCode: 0,
      model: "openai-codex/gpt-5.5",
    });
    expect(state.createCalls).toBe(1);
    expect(state.runCalls).toEqual([
      {
        containerId: "ctr_1",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        models: [
          "anthropic/claude-sonnet-4-6",
          "openai-codex/gpt-5.5",
          "openai/gpt-5.4",
        ],
      },
    ]);
  });

  it("re-execs PI with the next fallback when a model exits nonzero", async () => {
    state.exitCodes = [1, 0];
    state.resultModels = [undefined, "openai/gpt-5.4"];
    const logs: string[] = [];
    const { createDriver } = await import("../src/driver.js");

    const result = await createDriver().execRun("wks_fallback", {
      runId: "run_fallback",
      workspaceSlug: "fallback-workspace",
      prompt: "hi",
      model: "anthropic/claude-sonnet-4-6",
      modelFallbacks: ["openai/gpt-5.4"],
      onLog: (evt) => logs.push(evt.payload),
    });

    expect(result).toMatchObject({
      exitCode: 0,
      model: "openai/gpt-5.4",
    });
    expect(state.createCalls).toBe(1);
    expect(state.runCalls).toEqual([
      {
        containerId: "ctr_1",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        models: [
          "anthropic/claude-sonnet-4-6",
          "openai/gpt-5.4",
        ],
      },
      {
        containerId: "ctr_1",
        provider: "openai",
        model: "gpt-5.4",
        models: ["openai/gpt-5.4"],
      },
    ]);
    expect(logs).toContain("Model anthropic/claude-sonnet-4-6 failed with exit 1; trying fallback openai/gpt-5.4.");
  });

  it("does not try fallbacks after an aborted run", async () => {
    state.exitCodes = [1];
    state.aborted = [true];
    const { createDriver } = await import("../src/driver.js");

    const result = await createDriver().execRun("wks_fallback", {
      runId: "run_fallback",
      workspaceSlug: "fallback-workspace",
      prompt: "hi",
      model: "anthropic/claude-sonnet-4-6",
      modelFallbacks: ["openai/gpt-5.4"],
      onLog: () => {},
    });

    expect(result).toMatchObject({
      exitCode: 130,
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(state.runCalls).toHaveLength(1);
  });
});
