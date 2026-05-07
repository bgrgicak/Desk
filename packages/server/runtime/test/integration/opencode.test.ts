/**
 * Integration test: executes a trivial OpenCode prompt end-to-end using the
 * free opencode/big-pickle model inside a real Docker sandbox.
 *
 * Runs automatically when Docker is available and the desk/sandbox:v1 image
 * is present. No API key required — uses the free opencode provider.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureLayout, ensureWorkspaceLayout, workspaceRootPath } from "@agent-desk/storage";
import { createOrReuse, stopSandbox, sandboxImage } from "../../src/docker.js";
import { createDriver, type LogEvent } from "../../src/driver.js";
import { detectEngine, type Engine } from "../../src/engine.js";
import { rmTempTree } from "./helpers.js";

let engineForSetup: Engine | null = null;
let SKIP = false;
try {
  engineForSetup = await detectEngine();
  if (!(await engineForSetup.imageId(sandboxImage()))) SKIP = true;
} catch {
  SKIP = true;
}
const describeIf = SKIP ? describe.skip : describe;

// Free model — no API key required.
const FREE_MODEL = "opencode/big-pickle";

let home: string;
const testAgentId = "agt_opencode_int_test";
const testWorkspaceSlug = "opencode-int-test";

beforeAll(async () => {
  if (SKIP) return;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-opencode-int-"));
  await ensureLayout(home);
  await ensureWorkspaceLayout(home, testWorkspaceSlug);
  process.env.DESK_HOME = home;
});

afterAll(async () => {
  if (SKIP) return;
  if (engineForSetup) {
    await engineForSetup.remove(`desk-sandbox-${testAgentId}`, true).catch(() => {});
  }
  await rmTempTree(home);
});

describeIf("opencode end-to-end", () => {
  it("execRun streams log events from a real OpenCode invocation", async () => {
    const handle = await createOrReuse(testAgentId, testWorkspaceSlug, home, {});
    const driver = createDriver();
    const logs: LogEvent[] = [];

    const result = await driver.execRun(testAgentId, {
      runId: "run_ai_test_1",
      prompt: "Say exactly: HELLO_DESK_TEST",
      workspaceSlug: testWorkspaceSlug,
      model: FREE_MODEL,
      providerKeys: {},
      onLog: (evt) => logs.push(evt),
    });

    expect(result.exitCode).toBe(0);
    expect(logs.length).toBeGreaterThan(0);

    expect(logs.some((l) => l.payload.includes('"type":"step_start"'))).toBe(true);
    expect(logs.some((l) => l.payload.includes('"type":"step_finish"'))).toBe(true);

    await stopSandbox(handle);
  }, 300_000); // 5 minutes — free model may be slower than paid

  it("execRun forwards attachments to opencode via --file so the model sees their contents", async () => {
    // The full attachment story (workspace-relative path → /home/agent/<rel>
    // → opencode --file → model sees content) only works if every seam is
    // right. A sentinel string is the simplest end-to-end probe.
    const sentinel = "PINEAPPLE-42-DESK-ATTACHMENT-PROBE";
    const wsRoot = workspaceRootPath(home, testWorkspaceSlug);
    await fs.writeFile(
      path.join(wsRoot, "sentinel.txt"),
      `The test token is ${sentinel}.\n`,
    );

    const handle = await createOrReuse(testAgentId, testWorkspaceSlug, home, {});
    const driver = createDriver();
    const logs: LogEvent[] = [];

    const result = await driver.execRun(testAgentId, {
      runId: "run_attach_probe_1",
      prompt: "Print the test token from the attached file exactly as written.",
      workspaceSlug: testWorkspaceSlug,
      attachments: ["sentinel.txt"],
      model: FREE_MODEL,
      providerKeys: {},
      onLog: (evt) => logs.push(evt),
    });

    expect(result.exitCode).toBe(0);
    const combined = logs.map((l) => l.payload).join("\n");
    expect(combined).toContain(sentinel);

    await stopSandbox(handle);
  }, 300_000); // 5 minutes — free model may be slower than paid
});
