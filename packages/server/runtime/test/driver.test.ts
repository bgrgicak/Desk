import { describe, it, expect } from "vitest";
import { buildOpencodeCommand } from "../src/driver.js";
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
    const cmd = buildOpencodeCommand({ promptFile: `${SANDBOX_HOME}/.desk-prompt-msg_1` });
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
});
