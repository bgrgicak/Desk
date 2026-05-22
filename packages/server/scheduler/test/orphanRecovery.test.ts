import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectCrashedOrphans, type OrphanCandidate } from "../src/orphanRecovery.js";

let home: string;

async function writeLog(c: OrphanCandidate, contents: string): Promise<void> {
  const dir = path.join(home, c.workspacePath, ".chats", c.chatId, "logs");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${c.id}.log`), contents);
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-orphan-recovery-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
});

describe("detectCrashedOrphans", () => {
  it("detects SIGTRAP (Trace/breakpoint trap, core dumped)", async () => {
    const c: OrphanCandidate = { id: "msg_1", chatId: "cht_1", workspacePath: "ws-1" };
    await writeLog(
      c,
      [
        'stdout\t{"type":"step_start","timestamp":1}',
        "stderr\tTrace/breakpoint trap (core dumped)",
        "stderr\tsh: 1: echo: echo: I/O error",
        "",
      ].join("\n"),
    );
    const crashed = await detectCrashedOrphans(home, [c]);
    expect(crashed).toHaveLength(1);
    expect(crashed[0].id).toBe("msg_1");
    expect(crashed[0].signature).toBe("SIGTRAP");
  });

  it("detects Segmentation fault", async () => {
    const c: OrphanCandidate = { id: "msg_seg", chatId: "cht_1", workspacePath: "ws-1" };
    await writeLog(c, "stderr\tSegmentation fault\n");
    const crashed = await detectCrashedOrphans(home, [c]);
    expect(crashed.map((x) => x.signature)).toEqual(["SIGSEGV"]);
  });

  it("detects bare 'core dumped' marker", async () => {
    const c: OrphanCandidate = { id: "msg_core", chatId: "cht_1", workspacePath: "ws-1" };
    await writeLog(c, "stderr\tsomething went sideways (core dumped)\n");
    const crashed = await detectCrashedOrphans(home, [c]);
    expect(crashed[0].signature).toBe("core_dumped");
  });

  it("ignores logs without a fatal-signal signature", async () => {
    const c: OrphanCandidate = { id: "msg_clean", chatId: "cht_1", workspacePath: "ws-1" };
    await writeLog(
      c,
      [
        'stdout\t{"type":"step_start","timestamp":1}',
        'stdout\t{"type":"tool_use","timestamp":2}',
        "",
      ].join("\n"),
    );
    const crashed = await detectCrashedOrphans(home, [c]);
    expect(crashed).toEqual([]);
  });

  it("ignores OOM-style 'Killed' so auto-grow path still triggers on requeue", async () => {
    // SIGKILL/OOM is handled by sandbox auto-grow, not by failing the run.
    // Make sure we don't accidentally short-circuit that retry path.
    const c: OrphanCandidate = { id: "msg_oom", chatId: "cht_1", workspacePath: "ws-1" };
    await writeLog(c, "stderr\tKilled\n");
    const crashed = await detectCrashedOrphans(home, [c]);
    expect(crashed).toEqual([]);
  });

  it("treats a missing log file as 'no crash evidence' (lets recover requeue)", async () => {
    const c: OrphanCandidate = { id: "msg_never_ran", chatId: "cht_1", workspacePath: "ws-1" };
    const crashed = await detectCrashedOrphans(home, [c]);
    expect(crashed).toEqual([]);
  });

  it("scans only the tail — a crash near the start of a long log still wins", async () => {
    const c: OrphanCandidate = { id: "msg_late", chatId: "cht_1", workspacePath: "ws-1" };
    const filler = "stdout\t" + "x".repeat(4_000) + "\n";
    // Repeat enough filler that the crash marker is comfortably inside the
    // tail window but the file as a whole exceeds it.
    await writeLog(c, filler.repeat(10) + "stderr\tTrace/breakpoint trap (core dumped)\n");
    const crashed = await detectCrashedOrphans(home, [c]);
    expect(crashed[0].signature).toBe("SIGTRAP");
  });

  it("returns one entry per crashed candidate, skipping the clean ones", async () => {
    const dirty: OrphanCandidate = { id: "msg_dirty", chatId: "cht_a", workspacePath: "ws-a" };
    const clean: OrphanCandidate = { id: "msg_clean", chatId: "cht_a", workspacePath: "ws-a" };
    await writeLog(dirty, "stderr\tTrace/breakpoint trap (core dumped)\n");
    await writeLog(clean, 'stdout\t{"type":"step_finish"}\n');
    const crashed = await detectCrashedOrphans(home, [dirty, clean]);
    expect(crashed.map((c) => c.id)).toEqual(["msg_dirty"]);
  });
});
