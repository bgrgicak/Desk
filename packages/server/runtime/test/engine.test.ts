/**
 * Unit tests for the engine module.
 *
 * The CLI shim itself is exercised by integration tests under
 * `test/integration/sandbox.test.ts` (real docker / nerdctl). What this file
 * pins down is the small bit of pure logic that doesn't need a daemon:
 * detection ordering and the rejected-name preservation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectEngine, _isRemovalAlreadyInProgressForTest, _resetEngineCache, _wrapExecChildForTest, formatEngineErrorMessage, type EngineName } from "../src/engine.js";
import { RoomyError } from "@roomy-ai/shared";

const PRIOR_OVERRIDE = process.env.ROOMY_CONTAINER_ENGINE;
const PRIOR_PATH = process.env.PATH;

beforeEach(() => {
  _resetEngineCache();
});

afterEach(() => {
  if (PRIOR_OVERRIDE === undefined) delete process.env.ROOMY_CONTAINER_ENGINE;
  else process.env.ROOMY_CONTAINER_ENGINE = PRIOR_OVERRIDE;
  process.env.PATH = PRIOR_PATH;
  _resetEngineCache();
});

describe("detectEngine — ROOMY_CONTAINER_ENGINE override", () => {
  it("honors a docker override when docker is reachable", async () => {
    if (!(await binaryWorks("docker"))) {
      // Skip cleanly when neither runtime is present on the host.
      return;
    }
    process.env.ROOMY_CONTAINER_ENGINE = "docker";
    const engine = await detectEngine();
    expect(engine.name).toBe<EngineName>("docker");
  });

  it("honors a nerdctl override when nerdctl is reachable", async () => {
    if (!(await binaryWorks("nerdctl"))) return;
    process.env.ROOMY_CONTAINER_ENGINE = "nerdctl";
    const engine = await detectEngine();
    expect(engine.name).toBe<EngineName>("nerdctl");
  });

  it("throws a descriptive error when no runtime is available", async () => {
    // Neutralise PATH so neither binary can be found.
    process.env.PATH = "/nonexistent";
    delete process.env.ROOMY_CONTAINER_ENGINE;
    await expect(detectEngine()).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      message: expect.stringMatching(/No container runtime/),
    });
    await expect(detectEngine()).rejects.toBeInstanceOf(RoomyError);
  });
});

describe("exec handle stream lifecycle", () => {
  it("does not resolve wait() on exit before stdout/stderr have closed", async () => {
    const child = new EventEmitter() as NodeJS.EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => {};

    const handle = _wrapExecChildForTest(child as never);
    const chunks: Buffer[] = [];
    handle.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    let resolved = false;
    const wait = handle.wait().then((code) => {
      resolved = true;
      return code;
    });

    child.emit("exit", 0);
    await Promise.resolve();
    expect(resolved).toBe(false);

    child.stdout.write("late stdout");
    child.stdout.end();
    child.stderr.end();
    child.exitCode = 0;
    child.emit("close", 0);

    await expect(wait).resolves.toBe(0);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("late stdout");
  });
});

describe("container removal", () => {
  it("recognizes Docker's duplicate removal race as idempotent", () => {
    expect(_isRemovalAlreadyInProgressForTest(
      "Error response from daemon: removal of container roomy-sandbox-wks_x is already in progress",
    )).toBe(true);
  });

  it("waits for an already-in-progress removal instead of failing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-engine-fake-"));
    const fakeDocker = path.join(dir, "docker");
    await fs.writeFile(fakeDocker, `#!/bin/sh
if [ "$1" = "info" ]; then exit 0; fi
if [ "$1" = "rm" ]; then
  printf '%s\n' 'Error response from daemon: removal of container roomy-sandbox-wks_x is already in progress' >&2
  exit 1
fi
if [ "$1" = "inspect" ]; then
  printf '%s\n' 'Error: No such object: roomy-sandbox-wks_x' >&2
  exit 1
fi
exit 99
`);
    await fs.chmod(fakeDocker, 0o755);
    process.env.PATH = `${dir}:${PRIOR_PATH ?? ""}`;
    process.env.ROOMY_CONTAINER_ENGINE = "docker";
    _resetEngineCache();

    const engine = await detectEngine();
    await expect(engine.remove("roomy-sandbox-wks_x", true)).resolves.toBeUndefined();
  });
});

describe("formatEngineErrorMessage — secret redaction", () => {
  it("scrubs --env values but keeps keys visible", () => {
    const args = [
      "exec",
      "-d",
      "--user", "0:0",
      "--env", "PI_AUTH_JSON_BASE64=abc123-very-secret",
      "--env", "ANTHROPIC_API_KEY=sk-ant-real-key-xyz",
      "--env", "GITHUB_TOKEN=ghp_definitelyAtoken",
      "--env", "EMPTY_VAR=",
      "container-id",
      "sh", "-c", "echo hi",
    ];
    const msg = formatEngineErrorMessage("docker", args, "Error: container vanished", 1);
    expect(msg).toContain("docker exec -d --user 0:0");
    // Keys remain visible
    expect(msg).toContain("PI_AUTH_JSON_BASE64=<REDACTED>");
    expect(msg).toContain("ANTHROPIC_API_KEY=<REDACTED>");
    expect(msg).toContain("GITHUB_TOKEN=<REDACTED>");
    expect(msg).toContain("EMPTY_VAR=<REDACTED>");
    // Values must not appear anywhere in the rendered message
    expect(msg).not.toContain("abc123-very-secret");
    expect(msg).not.toContain("sk-ant-real-key-xyz");
    expect(msg).not.toContain("ghp_definitelyAtoken");
    // Exit code + stderr preserved
    expect(msg).toContain("(exit 1)");
    expect(msg).toContain("Error: container vanished");
  });

  it("handles --env without a following value defensively", () => {
    // Should not crash if the caller misuses the API.
    const msg = formatEngineErrorMessage("docker", ["exec", "--env"], "boom", 2);
    expect(msg).toContain("docker exec --env");
    expect(msg).toContain("(exit 2)");
    expect(msg).toContain("boom");
  });

  it("preserves messages with no env args unchanged", () => {
    const msg = formatEngineErrorMessage("docker", ["inspect", "foo"], "no such object", 1);
    expect(msg).toBe("docker inspect foo failed (exit 1)\nno such object");
  });
});

/** True if `<bin> info` exits 0 — same probe detectEngine uses. */
async function binaryWorks(name: EngineName): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(
      name,
      ["info", "--format", "{{.ID}}"],
      {
        env: process.env.XDG_RUNTIME_DIR
          ? process.env
          : { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.() ?? 1000}` },
        stdio: "ignore",
        timeout: 3000,
        killSignal: "SIGKILL",
      },
    );
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(false);
    }, 3000);
    child.on("error", () => done(false));
    child.on("exit", (code) => done(code === 0));
  });
}
