import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { buildOpencodeCommand, _cleanupRunProcessTreeForTest } from "../src/driver.js";
import type { Engine, ExecHandle, ExecSpec } from "../src/engine.js";
import { SANDBOX_HOME } from "../src/mounts.js";

describe("buildOpencodeCommand", () => {
  it("omits --file when no attachments are given", () => {
    const cmd = buildOpencodeCommand({ agentFileId: "agt_1" });
    expect(cmd[0]).toBe("sh");
    expect(cmd[1]).toBe("-c");
    expect(cmd[2]).not.toContain("--file");
    expect(cmd[2]).toContain("--agent agt_1");
  });

  it("translates workspace-relative paths to sandbox paths and quotes them", () => {
    const cmd = buildOpencodeCommand({
      agentFileId: "agt_1",
      attachments: [
        ".chats/cht_1/attachments/notes.txt",
        "Random/flout/node_modules/@esbuild/linux-x64/bin/esbuild",
      ],
    });
    const shell = cmd[2];
    expect(shell).toContain(`--file '${SANDBOX_HOME}/.chats/cht_1/attachments/notes.txt'`);
    expect(shell).toContain(
      `--file '${SANDBOX_HOME}/Random/flout/node_modules/@esbuild/linux-x64/bin/esbuild'`,
    );
    const idxFirst = shell.indexOf("notes.txt");
    const idxSecond = shell.indexOf("esbuild");
    expect(idxFirst).toBeGreaterThan(0);
    expect(idxSecond).toBeGreaterThan(idxFirst);
  });

  it("forwards directory paths through --file just like files", () => {
    const cmd = buildOpencodeCommand({
      attachments: ["Photos/2024", "Notes/work/inbox.md"],
    });
    const shell = cmd[2];
    expect(shell).toContain(`--file '${SANDBOX_HOME}/Photos/2024'`);
    expect(shell).toContain(`--file '${SANDBOX_HOME}/Notes/work/inbox.md'`);
  });

  it("includes --model when specified", () => {
    const cmd = buildOpencodeCommand({ model: "opencode/big-pickle" });
    expect(cmd[2]).toContain("--model 'opencode/big-pickle'");
  });

  it("omits --model when not specified", () => {
    const cmd = buildOpencodeCommand({});
    expect(cmd[2]).not.toContain("--model");
  });

  it("reads prompt from file when promptFile is set", () => {
    const cmd = buildOpencodeCommand({ runId: "msg_1", promptFile: `${SANDBOX_HOME}/.desk-prompt-msg_1` });
    expect(cmd[2]).toContain(`"$(cat "$DESK_PROMPT_FILE")"`);
    expect(cmd[2]).not.toContain(`"$DESK_PROMPT"`);
  });

  it("falls back to DESK_PROMPT env when promptFile is omitted", () => {
    const cmd = buildOpencodeCommand({});
    expect(cmd[2]).toContain(`"$DESK_PROMPT"`);
    expect(cmd[2]).not.toContain("DESK_PROMPT_FILE");
  });

  it("survives spaces, single quotes, and leading slashes in paths", () => {
    const cmd = buildOpencodeCommand({
      attachments: [
        "My Docs/quote's & spaces.md",
        "/already/absolute-looking/file.txt",
      ],
    });
    const shell = cmd[2];
    expect(shell).toContain(`--file '${SANDBOX_HOME}/My Docs/quote'\\''s & spaces.md'`);
    expect(shell).toContain(`--file '${SANDBOX_HOME}/already/absolute-looking/file.txt'`);
    expect(shell).not.toContain(`${SANDBOX_HOME}//`);
  });

  it("starts OpenCode as a cleanup-addressable process group", () => {
    const cmd = buildOpencodeCommand({ runId: "run_cleanup_1" });
    const shell = cmd[2];
    expect(shell).toContain("mkdir -p /tmp/desk-runs");
    expect(shell).toContain("pidfile='/tmp/desk-runs/run_cleanup_1.pid'");
    expect(shell).toContain("command -v setsid");
    expect(shell).toContain("exec setsid --wait sh -c");
    expect(shell).toContain("echo $$");
    expect(shell).toContain("opencode run");
  });

  it("does not fail startup when setsid is missing", () => {
    const cmd = buildOpencodeCommand({ runId: "run_no_setsid_1" });
    const shell = cmd[2];
    expect(shell).toContain("setsid unavailable; process-tree cleanup degraded");
    expect(shell).toContain("exec sh -c 'echo $$ >");
    expect(shell).not.toContain("exit 127");
  });

  it("sanitizes run ids before using them in pidfile paths", () => {
    const cmd = buildOpencodeCommand({ runId: "../weird run/id" });
    expect(cmd[2]).toContain("pidfile='/tmp/desk-runs/.._weird_run_id.pid'");
  });

  it("generates syntactically valid POSIX shell", () => {
    const cmd = buildOpencodeCommand({
      runId: "run_shell_check_1",
      agentFileId: "agt_1",
      attachments: ["My Docs/quote's.md"],
      model: "opencode/big-pickle",
      promptFile: `${SANDBOX_HOME}/.desk-prompt-msg_1`,
    });
    const checked = spawnSync("sh", ["-n", "-c", cmd[2]], { encoding: "utf8" });
    expect(checked.status, checked.stderr).toBe(0);
  });
});

describe("cleanupRunProcessTree", () => {
  // Minimal Engine fake: each `exec` runs the supplied shell-script string
  // through a handler that returns an exit code. We track the commands the
  // cleanup issued so the assertions can check "did it send a kill signal?"
  // without standing up a real container.
  type Handler = (script: string) => number;
  function fakeEngine(handler: Handler): { engine: Engine; calls: string[] } {
    const calls: string[] = [];
    const exec = async (spec: ExecSpec): Promise<ExecHandle> => {
      const script = spec.cmd.join(" ");
      calls.push(script);
      const code = handler(script);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.end();
      stderr.end();
      return {
        stdout,
        stderr,
        wait: async () => code,
        cancel: async () => {},
      };
    };
    return {
      calls,
      engine: {
        name: "docker",
        exec,
        // The rest of the Engine surface isn't used by cleanupRunProcessTree.
      } as unknown as Engine,
    };
  }

  it("skips signalling when skipIfLeaderAlive is true and the leader is alive", async () => {
    // pidfile present (returns 0 from `[ -s … ]`), `kill -0 $pid` returns 0
    // (alive). The cleanup must NOT send TERM/KILL — otherwise a dev-server
    // restart kills an opencode that the user wants to keep running.
    const { engine, calls } = fakeEngine((script) => {
      if (script.includes("[ -s ")) return 0; // pidfile exists
      if (script.includes("kill -0")) return 0; // leader alive
      if (script.includes("rm -f")) return 0;
      // A `kill -TERM -- "-…"` call would land here — treat it as failure so
      // the test catches a regression where signalling slips through.
      if (script.includes("kill -")) return 99;
      return 0;
    });
    const signalled = await _cleanupRunProcessTreeForTest(engine, "c", "/tmp/desk-runs/x.pid", {
      skipIfLeaderAlive: true,
    });
    expect(signalled).toBe(false);
    expect(calls.some((c) => c.includes("kill -TERM"))).toBe(false);
    expect(calls.some((c) => c.includes("kill -KILL"))).toBe(false);
  });

  it("signals the process group when the leader has already exited", async () => {
    // pidfile present, but the leader PID is dead (kill -0 returns non-zero).
    // We expect a TERM to land — the cleanup is what sweeps leftover
    // playwright-mcp / npx descendants that outlived opencode.
    const { engine, calls } = fakeEngine((script) => {
      if (script.includes("[ -s ")) return 0;
      if (script.includes("kill -0")) return 1; // leader is gone
      if (script.includes("kill -TERM")) return 42; // PGID signalled
      return 0;
    });
    const signalled = await _cleanupRunProcessTreeForTest(engine, "c", "/tmp/desk-runs/x.pid", {
      skipIfLeaderAlive: true,
    });
    expect(signalled).toBe(true);
    expect(calls.some((c) => c.includes("kill -TERM"))).toBe(true);
  });

  it("always signals when skipIfLeaderAlive is omitted (cancelRun path)", async () => {
    // cancelRun never sets skipIfLeaderAlive: an explicit cancel must tear
    // the tree down even if the leader is still running.
    const { engine, calls } = fakeEngine((script) => {
      if (script.includes("[ -s ")) return 0;
      if (script.includes("kill -TERM")) return 42;
      if (script.includes("kill -KILL")) return 42;
      return 0;
    });
    const signalled = await _cleanupRunProcessTreeForTest(engine, "c", "/tmp/desk-runs/x.pid", {});
    expect(signalled).toBe(true);
    expect(calls.some((c) => c.includes("kill -TERM"))).toBe(true);
    expect(calls.some((c) => c.includes("kill -0"))).toBe(false);
  });
});
