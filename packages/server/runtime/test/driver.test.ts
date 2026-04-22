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

    const result = await driver.execRun("wks_test", {
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

  it("execRun awaits slow async onLog callbacks before resolving", async () => {
    // Regression: before the fix, execRun resolved on stream-end without
    // waiting for async onLog returns. For short runs this meant the
    // scheduler read back zero events and never persisted the assistant
    // message. Simulate the race with a slow persister.
    const driver = createDriver();
    const commits: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await driver.execRun("wks_test", {
      runId: "run_race_test",
      prompt: "hi",
      onLog: async (evt) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        commits.push(evt.payload);
        inFlight--;
      },
    });

    expect(result.exitCode).toBe(0);
    // All log commits must be complete by the time execRun resolves.
    expect(inFlight).toBe(0);
    expect(commits.length).toBeGreaterThan(0);
    expect(maxInFlight).toBeGreaterThan(0); // sanity: the callbacks were slow
  });

  it("cancelRun causes early exit", async () => {
    const driver = createDriver();
    const logs: LogEvent[] = [];

    // Cancel immediately
    await driver.cancelRun("run_cancel_test");

    const result = await driver.execRun("wks_test", {
      runId: "run_cancel_test",
      prompt: "Should be cancelled",
      onLog: (evt) => logs.push(evt),
    });

    expect(result.exitCode).toBe(130);
  });
});
