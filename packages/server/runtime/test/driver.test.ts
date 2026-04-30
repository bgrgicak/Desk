import { describe, it, expect, beforeAll } from "vitest";
import type { LogEvent } from "../src/driver.js";
import { buildOpencodeCommand, createDriver } from "../src/driver.js";
import { SANDBOX_HOME } from "../src/mounts.js";

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

  it("buildOpencodeCommand omits --file when no attachments are given", () => {
    const cmd = buildOpencodeCommand({ agentFileId: "agt_1" });
    expect(cmd[0]).toBe("sh");
    expect(cmd[1]).toBe("-c");
    expect(cmd[2]).not.toContain("--file");
    expect(cmd[2]).toContain("--agent agt_1");
  });

  it("buildOpencodeCommand translates workspace-relative paths to sandbox paths and quotes them", () => {
    const cmd = buildOpencodeCommand({
      agentFileId: "agt_1",
      attachments: [
        ".chats/cht_1/attachments/notes.txt",
        "Random/flout/node_modules/@esbuild/linux-x64/bin/esbuild",
      ],
    });
    const shell = cmd[2];
    // Each attachment lands as a separate --file flag, in order.
    expect(shell).toContain(`--file '${SANDBOX_HOME}/.chats/cht_1/attachments/notes.txt'`);
    expect(shell).toContain(
      `--file '${SANDBOX_HOME}/Random/flout/node_modules/@esbuild/linux-x64/bin/esbuild'`,
    );
    // Path order is preserved.
    const idxFirst = shell.indexOf("notes.txt");
    const idxSecond = shell.indexOf("esbuild");
    expect(idxFirst).toBeGreaterThan(0);
    expect(idxSecond).toBeGreaterThan(idxFirst);
  });

  it("buildOpencodeCommand forwards directory paths through --file just like files", () => {
    // opencode's `--file` accepts both file and directory paths; the driver
    // is path-kind agnostic, so the same wire format carries either.
    const cmd = buildOpencodeCommand({
      attachments: ["Photos/2024", "Notes/work/inbox.md"],
    });
    const shell = cmd[2];
    expect(shell).toContain(`--file '${SANDBOX_HOME}/Photos/2024'`);
    expect(shell).toContain(`--file '${SANDBOX_HOME}/Notes/work/inbox.md'`);
  });

  it("buildOpencodeCommand includes --model when specified", () => {
    const cmd = buildOpencodeCommand({ model: "opencode/big-pickle" });
    expect(cmd[2]).toContain("--model 'opencode/big-pickle'");
  });

  it("buildOpencodeCommand omits --model when not specified", () => {
    const cmd = buildOpencodeCommand({});
    expect(cmd[2]).not.toContain("--model");
  });

  it("buildOpencodeCommand survives spaces, single quotes, and leading slashes in paths", () => {
    const cmd = buildOpencodeCommand({
      attachments: [
        "My Docs/quote's & spaces.md",
        "/already/absolute-looking/file.txt",
      ],
    });
    const shell = cmd[2];
    // Single quotes inside a path are escaped as `'\''` (close, escape, reopen).
    expect(shell).toContain(`--file '${SANDBOX_HOME}/My Docs/quote'\\''s & spaces.md'`);
    // Leading slash on the workspace-relative path is collapsed so we don't
    // produce `/home/agent//already/...`.
    expect(shell).toContain(`--file '${SANDBOX_HOME}/already/absolute-looking/file.txt'`);
    expect(shell).not.toContain(`${SANDBOX_HOME}//`);
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
