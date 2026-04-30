/**
 * Integration tests for the Docker sandbox lifecycle.
 * Requires a running Docker daemon. Auto-detected — skipped when Docker is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureLayout, ensureWorkspaceLayout, workspaceRootPath } from "@agent-desk/storage";
import { createOrReuse, stopSandbox, ensureImage, dockerSocketPath } from "../../src/docker.js";
import { execInSandbox } from "../../src/sandboxExec.js";
import { projectMounts, teardownMounts, SANDBOX_HOME } from "../../src/mounts.js";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function sandboxImageAvailable(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", "desk/sandbox:v1"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !dockerAvailable() || !sandboxImageAvailable();
const describeIf = SKIP ? describe.skip : describe;

let home: string;
const testWorkspaceId = "wks_int_sandbox_test";
const testWorkspaceSlug = "int-sandbox-test";

beforeAll(async () => {
  if (SKIP) return;
  // Make sure we're not using the fake driver
  delete process.env.DESK_SANDBOX_DRIVER;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-sandbox-int-"));
  await ensureLayout(home);
  await ensureWorkspaceLayout(home, testWorkspaceSlug);
  process.env.DESK_HOME = home;
});

afterAll(async () => {
  if (SKIP) return;
  // Clean up container
  try {
    const handle = { containerId: "", workspaceId: testWorkspaceId };
    const Docker = (await import("dockerode")).default;
    const docker = new Docker({ socketPath: dockerSocketPath() });
    const container = docker.getContainer(`desk-sandbox-${testWorkspaceId}`);
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
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    expect(handle.workspaceId).toBe(testWorkspaceId);
    expect(handle.containerId).toBeTruthy();
  });

  it("createOrReuse is idempotent — second call returns same container", async () => {
    const h1 = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const h2 = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    expect(h1.containerId).toBe(h2.containerId);
  });

  it("createOrReuse rebuilds a container whose binds drifted from the current plan", async () => {
    const first = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);

    // Force drift by calling with an extra bind the existing container
    // doesn't have. Without the drift check, createOrReuse would hand back
    // the old container and the new bind would silently go missing.
    const extra = await fs.mkdtemp(path.join(os.tmpdir(), "desk-drift-"));
    try {
      const plan = [
        {
          sourcePath: workspaceRootPath(home, testWorkspaceSlug),
          targetPath: SANDBOX_HOME,
          mode: "rw" as const,
          category: "workspace" as const,
        },
        {
          sourcePath: extra,
          targetPath: "/mnt/extra",
          mode: "ro" as const,
          category: "external" as const,
        },
      ];
      const second = await createOrReuse(
        testWorkspaceId, testWorkspaceSlug, home, undefined, plan,
      );
      expect(second.containerId).not.toBe(first.containerId);

      const Docker = (await import("dockerode")).default;
      const docker = new Docker({ socketPath: dockerSocketPath() });
      const info = await docker.getContainer(second.containerId).inspect();
      expect(info.HostConfig?.Binds ?? []).toContain(`${extra}:/mnt/extra:ro`);
    } finally {
      await fs.rm(extra, { recursive: true, force: true });
    }
  });

  it("projectMounts resolves the workspace root that gets bind-mounted at $HOME", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const mounts = await projectMounts(handle, {
      home,
      workspaceId: "wks_int_test",
      workspaceSlug: testWorkspaceSlug,
      runId: "run_int_1",
    });

    expect(mounts.workspace).toBe(workspaceRootPath(home, testWorkspaceSlug));

    // The workspace root should exist on disk
    const stat = await fs.stat(mounts.workspace);
    expect(stat.isDirectory()).toBe(true);

    // And it's what gets mounted at /home/agent inside the sandbox
    expect(SANDBOX_HOME).toBe("/home/agent");

    await teardownMounts(handle, "run_int_1");
  });

  it("runs a no-op command inside the sandbox", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
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

  it("forwards provider API keys from host env to the sandbox", async () => {
    // Pick a sentinel from the forwarded set that opencode recognises
    // (see PROVIDER_KEY_VARS in runtime/src/docker.ts).
    const envKey = "OPENAI_API_KEY";
    const secret = "sk-desk-env-forwarding-test-123";
    const prev = process.env[envKey];
    process.env[envKey] = secret;

    // Force recreation of this test's container so it picks up the new env.
    try {
      const Docker = (await import("dockerode")).default;
      const docker = new Docker({ socketPath: dockerSocketPath() });
      const stale = docker.getContainer(`desk-sandbox-${testWorkspaceId}`);
      await stale.stop({ t: 2 }).catch(() => {});
      await stale.remove({ force: true }).catch(() => {});
    } catch { /* ok */ }

    try {
      const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
      const Docker = (await import("dockerode")).default;
      const docker = new Docker({ socketPath: dockerSocketPath() });
      const container = docker.getContainer(handle.containerId);

      const exec = await container.exec({
        Cmd: ["sh", "-c", `echo "$${envKey}"`],
        AttachStdout: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve) => {
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => resolve());
      });
      const out = Buffer.concat(chunks).toString("utf8");
      expect(out).toContain(secret);
    } finally {
      if (prev === undefined) delete process.env[envKey];
      else process.env[envKey] = prev;
    }
  });

  it("execInSandbox refreshes provider keys on a reused container", async () => {
    // Regression: a sandbox first created without keys (or with stale keys)
    // used to keep that env until tear-down, so opencode would hit Anthropic
    // with an empty/old token even after the user saved a new one. The fix
    // injects providerKeys at each exec; this test pins that behaviour.
    const envKey = "ANTHROPIC_API_KEY";
    const stale = "sk-stale-original";
    const fresh = "sk-fresh-rotated";

    // Recreate the container so it starts with the "stale" value baked in.
    try {
      const Docker = (await import("dockerode")).default;
      const docker = new Docker({ socketPath: dockerSocketPath() });
      const old = docker.getContainer(`desk-sandbox-${testWorkspaceId}`);
      await old.stop({ t: 2 }).catch(() => {});
      await old.remove({ force: true }).catch(() => {});
    } catch { /* ok */ }

    await createOrReuse(testWorkspaceId, testWorkspaceSlug, home, { [envKey]: stale });

    const result = await execInSandbox(testWorkspaceId, testWorkspaceSlug, {
      argv: ["sh", "-c", `echo "$${envKey}"`],
      providerKeys: { [envKey]: fresh },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(fresh);
    expect(result.stdout).not.toContain(stale);
  });

  it("stopSandbox stops the container", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    await stopSandbox(handle);

    const Docker = (await import("dockerode")).default;
    const docker = new Docker({ socketPath: dockerSocketPath() });
    const container = docker.getContainer(handle.containerId);
    const info = await container.inspect();
    expect(info.State.Running).toBe(false);
  });
});
