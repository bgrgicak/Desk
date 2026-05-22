import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalAssistantMessage, type PiJsonEvent } from "../src/piEvents.js";

const spawnedChildren: MockChildProcess[] = [];

class MockChildProcess extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  kill = vi.fn();
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const ch = new MockChildProcess();
    spawnedChildren.push(ch);
    return ch;
  }),
}));

// Imported after the mock so `runPi`'s internal `spawn` references the mock.
const { runPi, watchPiSessionTerminal } = await import("../src/piClient.js");

const watchers: Array<{ stop(): void }> = [];

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop();
  spawnedChildren.length = 0;
});

async function createSessionDir(): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-pi-session-"));
  const file = path.join(dir, "session.jsonl");
  return { dir, file };
}

function message(stopReason: "stop" | "error", text = "", errorMessage?: string): PiJsonEvent {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
    },
  };
}

async function appendJson(file: string, evt: PiJsonEvent): Promise<void> {
  await fs.appendFile(file, `${JSON.stringify(evt)}\n`, "utf8");
}

function waitForTerminal(
  dir: string,
  opts?: Parameters<typeof watchPiSessionTerminal>[2],
): Promise<PiJsonEvent> {
  return new Promise((resolve) => {
    const watcher = watchPiSessionTerminal(dir, (evt) => resolve(evt), {
      pollMs: 5,
      successGraceMs: 5,
      errorGraceMs: 30,
      ...opts,
    });
    watchers.push(watcher);
  });
}

describe("watchPiSessionTerminal", () => {
  it("ignores terminal messages already present before the run starts", async () => {
    const { dir, file } = await createSessionDir();
    await appendJson(file, message("stop", "old answer"));

    const terminal = waitForTerminal(dir);
    await appendJson(file, { type: "message", message: { role: "user", content: [] } });
    await appendJson(file, message("stop", "new answer"));

    expect(terminalAssistantMessage(await terminal)?.text).toBe("new answer");
  });

  it("lets pi continue after a transient error when a later success arrives", async () => {
    const { dir, file } = await createSessionDir();
    await fs.writeFile(file, "", "utf8");

    const terminal = waitForTerminal(dir, { errorGraceMs: 80 });
    await appendJson(file, message("error", "", "temporary overload"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await appendJson(file, message("stop", "retry won"));

    const out = terminalAssistantMessage(await terminal);
    expect(out).toMatchObject({ exitCode: 0, text: "retry won" });
  });

  it("emits a final error after the retry grace expires", async () => {
    const { dir, file } = await createSessionDir();
    await fs.writeFile(file, "", "utf8");

    const terminal = waitForTerminal(dir, { errorGraceMs: 15 });
    await appendJson(file, message("error", "", "model unavailable"));

    const out = terminalAssistantMessage(await terminal);
    expect(out).toMatchObject({
      exitCode: 1,
      errorMessage: "model unavailable",
    });
  });
});

describe("runPi done semantics", () => {
  it("resolves on pi's terminal event even when the wrapper never exits", async () => {
    // Regression for chats stuck in `state='running'` because the docker
    // exec wrapper hung past pi's actual end-of-turn (e.g. a non-exiting
    // MCP child held the wrapper alive). `done` must resolve on the
    // terminal event, not on child.on("exit").
    const fakeEngine = {
      name: "docker",
      exec: vi.fn(async () => ({ wait: async () => 0 })),
    };

    const handle = runPi(fakeEngine as never, {
      containerId: "ctr_test",
      user: "1000:1000",
      cwd: "/home/agent",
      sessionId: "session_test",
      env: {},
      prompt: "hi",
      onEvent: () => {},
      onStderr: () => {},
      translate: { sessionID: "session_test", assistantMessageId: "msg_test" },
    });

    expect(spawnedChildren).toHaveLength(1);
    const child = spawnedChildren[0]!;

    // Push pi's terminal event onto the wrapper's stdout. The drain
    // picks it up and resolves `done` — without `child.exit` ever firing.
    child.stdout.push(`${JSON.stringify(message("stop", "all done"))}\n`);

    const result = await Promise.race([
      handle.done,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("done did not resolve within 500ms")), 500),
      ),
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.aborted).toBe(false);
    // Wrapper cleanup is scheduled in the background; assert it gets
    // kicked off (SIGTERM after a 100ms grace) so we don't accidentally
    // strand the wrapper.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
