/**
 * Integration test: executes a trivial OpenCode prompt end-to-end
 * against the real Anthropic API inside a real Docker sandbox.
 *
 * Runs automatically when ANTHROPIC_API_KEY is set and Docker is available.
 * Requires: Docker daemon, ANTHROPIC_API_KEY, desk/sandbox:v1 image.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureLayout, ensureWorkspaceLayout } from "@desk/storage";
import { createOrReuse, stopSandbox, dockerSocketPath } from "../../src/docker.js";
import { createDriver, type LogEvent } from "../../src/driver.js";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const SKIP = !HAS_KEY || !dockerAvailable();
const describeIf = SKIP ? describe.skip : describe;

let home: string;
const testAgentId = "agt_opencode_int_test";
const testWorkspaceSlug = "opencode-int-test";

beforeAll(async () => {
  if (SKIP) return;
  delete process.env.DESK_SANDBOX_DRIVER;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-opencode-int-"));
  await ensureLayout(home);
  await ensureWorkspaceLayout(home, testWorkspaceSlug);
  process.env.DESK_HOME = home;
});

afterAll(async () => {
  if (SKIP) return;
  try {
    const Docker = (await import("dockerode")).default;
    const docker = new Docker({ socketPath: dockerSocketPath() });
    const container = docker.getContainer(`desk-sandbox-${testAgentId}`);
    await container.stop({ t: 2 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
  } catch { /* ok */ }
  await fs.rm(home, { recursive: true, force: true });
});

describeIf("opencode end-to-end", () => {
  it("execRun streams log events from a real OpenCode invocation", async () => {
    // Scope the container's provider env to Anthropic only. If OPENAI_API_KEY
    // leaks in from the host env, opencode's auto-detection picks an OpenAI
    // default (e.g. gpt-5.3-chat-latest) that the project may not have access
    // to, and the run fails before any model output is produced.
    const providerKeys = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" };
    const handle = await createOrReuse(testAgentId, testWorkspaceSlug, home, providerKeys);
    const driver = createDriver();
    const logs: LogEvent[] = [];

    const result = await driver.execRun(testAgentId, {
      runId: "run_ai_test_1",
      prompt: "Say exactly: HELLO_DESK_TEST",
      workspaceSlug: testWorkspaceSlug,
      onLog: (evt) => logs.push(evt),
      providerKeys,
    });

    expect(result.exitCode).toBe(0);
    expect(logs.length).toBeGreaterThan(0);

    const combined = logs.map((l) => l.payload).join("\n");
    expect(combined).toContain("HELLO_DESK_TEST");

    await stopSandbox(handle);
  }, 120_000); // 2 minute timeout for AI call
});
