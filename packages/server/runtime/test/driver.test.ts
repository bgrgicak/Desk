import { describe, it, expect, beforeAll } from "vitest";
import type { LogEvent } from "../src/driver.js";
import { createDriver } from "../src/driver.js";

beforeAll(() => {
  process.env.DESK_SANDBOX_DRIVER = "fake";
});

describe("fake driver", () => {
  it("execRun emits log events and returns exit code 0", async () => {
    const driver = createDriver();
    const logs: LogEvent[] = [];

    const result = await driver.execRun("agt_test", {
      runId: "run_test1",
      prompt: "Hello world",
      onLog: (evt) => logs.push(evt),
    });

    expect(result.exitCode).toBe(0);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].kind).toBe("stdout");
    expect(logs[0].runId).toBe("run_test1");
    // Sequences should be monotonic
    for (let i = 1; i < logs.length; i++) {
      expect(logs[i].seq).toBeGreaterThan(logs[i - 1].seq);
    }
  });

  it("cancelRun causes early exit", async () => {
    const driver = createDriver();
    const logs: LogEvent[] = [];

    // Cancel immediately
    await driver.cancelRun("run_cancel_test");

    const result = await driver.execRun("agt_test", {
      runId: "run_cancel_test",
      prompt: "Should be cancelled",
      onLog: (evt) => logs.push(evt),
    });

    expect(result.exitCode).toBe(130);
  });
});
