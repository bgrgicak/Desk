import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { terminalAssistantMessage, type PiJsonEvent } from "../src/piEvents.js";
import { watchPiSessionTerminal } from "../src/piClient.js";

const watchers: Array<{ stop(): void }> = [];

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop();
});

async function createSessionDir(): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-pi-session-"));
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
