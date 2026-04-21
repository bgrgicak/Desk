/**
 * Integration tests for the Docker sandbox lifecycle.
 * Requires a running Docker daemon. Auto-detected — skipped when Docker is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureLayout } from "@desk/storage";
import { createOrReuse, stopSandbox, ensureImage, dockerSocketPath } from "../../src/docker.js";
import { projectMounts, teardownMounts, sandboxMountRoot } from "../../src/mounts.js";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !dockerAvailable();
const describeIf = SKIP ? describe.skip : describe;

let home: string;
const testAgentId = "agt_int_sandbox_test";

beforeAll(async () => {
  if (SKIP) return;
  // Make sure we're not using the fake driver
  delete process.env.DESK_SANDBOX_DRIVER;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-sandbox-int-"));
  await ensureLayout(home);
  process.env.DESK_HOME = home;
});

afterAll(async () => {
  if (SKIP) return;
  // Clean up container
  try {
    const handle = { containerId: "", agentId: testAgentId };
    const Docker = (await import("dockerode")).default;
    const docker = new Docker({ socketPath: dockerSocketPath() });
    const container = docker.getContainer(`desk-sandbox-${testAgentId}`);
    await container.stop({ t: 2 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
  } catch { /* ok */ }

  await fs.rm(home, { recursive: true, force: true });
});

describeIf("sandbox integration", () => {
  it("ensureImage does not throw", async () => {
    await ensureImage();
  });

  it("createOrReuse creates a container and returns a handle", async () => {
    const handle = await createOrReuse(testAgentId, home);
    expect(handle.agentId).toBe(testAgentId);
    expect(handle.containerId).toBeTruthy();
  });

  it("createOrReuse is idempotent — second call returns same container", async () => {
    const h1 = await createOrReuse(testAgentId, home);
    const h2 = await createOrReuse(testAgentId, home);
    expect(h1.containerId).toBe(h2.containerId);
  });

  it("projectMounts creates staging dirs visible on host", async () => {
    const handle = await createOrReuse(testAgentId, home);
    const mounts = await projectMounts(handle, {
      home,
      workspaceId: "wks_int_test",
      runId: "run_int_1",
    });

    expect(mounts.files).toBeTruthy();
    expect(mounts.desktop).toBeTruthy();

    // The staging dir should exist on disk
    const root = sandboxMountRoot(home, testAgentId);
    const stat = await fs.stat(path.join(root, "desktop"));
    expect(stat.isDirectory()).toBe(true);

    await teardownMounts(handle, "run_int_1");
  });

  it("runs a no-op command inside the sandbox", async () => {
    const handle = await createOrReuse(testAgentId, home);
    const Docker = (await import("dockerode")).default;
    const docker = new Docker({ socketPath: dockerSocketPath() });
    const container = docker.getContainer(handle.containerId);

    const exec = await container.exec({
      Cmd: ["echo", "hello from sandbox"],
      AttachStdout: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks: string[] = [];
    await new Promise<void>((resolve) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      stream.on("end", resolve);
    });

    const output = chunks.join("").trim();
    expect(output).toContain("hello from sandbox");
  });

  it("stopSandbox stops the container", async () => {
    const handle = await createOrReuse(testAgentId, home);
    await stopSandbox(handle);

    const Docker = (await import("dockerode")).default;
    const docker = new Docker({ socketPath: dockerSocketPath() });
    const container = docker.getContainer(handle.containerId);
    const info = await container.inspect();
    expect(info.State.Running).toBe(false);
  });
});
